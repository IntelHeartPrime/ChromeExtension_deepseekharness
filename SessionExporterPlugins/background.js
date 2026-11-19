const SESSION_EXPORTER_URL = "http://127.0.0.1:8765/";
const SESSION_EXPORTER_ORIGIN = new URL(SESSION_EXPORTER_URL).origin;
const GROUP_STYLE = {title: "Session Exporter", color: "yellow"};
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;

let pendingWork = Promise.resolve();

function runInOrder(work) {
  pendingWork = pendingWork.then(work).catch((error) => {
    console.warn("Session Exporter shortcut:", error.message);
  });
}

function isSessionExporterTab(tab) {
  const url = tab.pendingUrl && (!tab.url || tab.url === "about:blank" ||
    tab.url === "chrome://newtab/") ? tab.pendingUrl : tab.url;
  return Boolean(url) && URL.canParse(url) && new URL(url).origin === SESSION_EXPORTER_ORIGIN;
}

function isNormalWindow(window) {
  return window?.type === "normal" && !window.incognito;
}

function groupKey(windowId) {
  return `sessionExporterGroup:${windowId}`;
}

async function syncWindow(window) {
  const key = groupKey(window.id);
  const { [key]: saved } = await chrome.storage.session.get(key);
  const tabs = window.tabs;
  const sessionExporterTabs = tabs.filter((tab) => !tab.pinned && isSessionExporterTab(tab));
  const groups = await chrome.tabGroups.query({windowId: window.id});
  const ownedGroup = groups.find((group) => group.id === saved?.id);

  if (ownedGroup) {
    const departed = tabs.filter((tab) => tab.groupId === ownedGroup.id &&
      saved.tabIds.includes(tab.id) && !isSessionExporterTab(tab));
    if (departed.length) await chrome.tabs.ungroup(departed.map((tab) => tab.id));
  }

  if (!sessionExporterTabs.length) {
    if (saved) await chrome.storage.session.remove(key);
    return;
  }

  const sessionExporterIds = sessionExporterTabs.map((tab) => tab.id);
  // Chrome can assign a new group ID when restoring a browser session.
  const restoredGroup = groups.find((group) => group.title === GROUP_STYLE.title &&
    group.color === GROUP_STYLE.color &&
    sessionExporterTabs.some((tab) => tab.groupId === group.id) &&
    tabs.every((tab) => tab.groupId !== group.id || sessionExporterIds.includes(tab.id)));
  const existingGroup = ownedGroup ?? restoredGroup;
  let groupId = existingGroup?.id;

  if (groupId === undefined) {
    groupId = await chrome.tabs.group({tabIds: sessionExporterIds, createProperties: {windowId: window.id}});
  } else {
    const newcomers = sessionExporterTabs.filter((tab) => tab.groupId !== groupId);
    if (newcomers.length) {
      // Ungrouping the last departing tab can delete the old group.
      const stillExists = (await chrome.tabGroups.query({windowId: window.id}))
        .some((group) => group.id === groupId);
      groupId = stillExists
        ? await chrome.tabs.group({tabIds: newcomers.map((tab) => tab.id), groupId})
        : await chrome.tabs.group({tabIds: sessionExporterIds, createProperties: {windowId: window.id}});
    }
  }

  await chrome.storage.session.set({[key]: {id: groupId, tabIds: sessionExporterIds}});
  if (groupId !== existingGroup?.id || existingGroup.title !== GROUP_STYLE.title ||
      existingGroup.color !== GROUP_STYLE.color) {
    await chrome.tabGroups.update(groupId, GROUP_STYLE);
  }
}

async function syncWindowById(windowId) {
  // A tab can be moved or closed before its queued event is handled.
  const window = await chrome.windows.get(windowId, {populate: true}).catch(() => null);
  if (isNormalWindow(window)) await syncWindow(window);
}

async function normalWindows() {
  const windows = await chrome.windows.getAll({windowTypes: ["normal"], populate: true});
  return windows.filter(isNormalWindow);
}

async function syncAllWindows() {
  for (const window of await normalWindows()) {
    await syncWindowById(window.id);
  }
}

async function openSessionExporter(sourceTab) {
  const windows = await normalWindows();
  const currentWindow = windows.find((window) => window.id === sourceTab.windowId);
  if (!currentWindow) return;

  const currentTabs = currentWindow.tabs.filter(isSessionExporterTab);
  const candidates = currentTabs.length ? currentTabs : windows.flatMap((window) => window.tabs.filter(isSessionExporterTab));
  const target = candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (!target) {
    const tab = await chrome.tabs.create({windowId: currentWindow.id, url: SESSION_EXPORTER_URL, active: true});
    await syncWindowById(tab.windowId);
    return;
  }

  await chrome.tabs.update(target.id, {active: true});
  if (target.windowId !== currentWindow.id) {
    await chrome.windows.update(target.windowId, {focused: true});
  }
  await syncWindowById(target.windowId);
  const focusedTab = await chrome.tabs.get(target.id);
  if (!focusedTab.pinned && focusedTab.groupId !== NO_GROUP) {
    await chrome.tabGroups.update(focusedTab.groupId, {collapsed: false});
  }
}

chrome.action.onClicked.addListener((tab) => runInOrder(() => openSessionExporter(tab)));
chrome.runtime.onInstalled.addListener(() => runInOrder(syncAllWindows));
chrome.runtime.onStartup.addListener(() => runInOrder(syncAllWindows));

chrome.tabs.onCreated.addListener((tab) => {
  if (isSessionExporterTab(tab)) runInOrder(() => syncWindowById(tab.windowId));
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  const changedMembership = change.groupId !== undefined || change.pinned !== undefined;
  // Cross-origin navigation may hide the new URL under the host permission.
  const changedAddress = change.url !== undefined || change.status === "complete";
  if (changedMembership || (changedAddress && (isSessionExporterTab(tab) || tab.groupId !== NO_GROUP))) {
    runInOrder(() => syncWindowById(tab.windowId));
  }
});
chrome.tabs.onAttached.addListener((_id, {newWindowId}) => runInOrder(() => syncWindowById(newWindowId)));
chrome.tabs.onDetached.addListener((_id, {oldWindowId}) => runInOrder(() => syncWindowById(oldWindowId)));
chrome.tabs.onRemoved.addListener((_id, {windowId, isWindowClosing}) => {
  if (!isWindowClosing) runInOrder(() => syncWindowById(windowId));
});
chrome.windows.onRemoved.addListener((windowId) => runInOrder(() => chrome.storage.session.remove(groupKey(windowId))));
