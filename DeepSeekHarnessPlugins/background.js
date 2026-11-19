const DSH_URL = "http://127.0.0.1:3080/";
const DSH_ORIGIN = new URL(DSH_URL).origin;
const GROUP_STYLE = {title: "DSH", color: "purple"};
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;

let pendingWork = Promise.resolve();

function runInOrder(work) {
  pendingWork = pendingWork.then(work).catch((error) => {
    console.warn("DSH shortcut:", error.message);
  });
}

function isDshTab(tab) {
  const url = tab.pendingUrl && (!tab.url || tab.url === "about:blank" ||
    tab.url === "chrome://newtab/") ? tab.pendingUrl : tab.url;
  return Boolean(url) && URL.canParse(url) && new URL(url).origin === DSH_ORIGIN;
}

function isNormalWindow(window) {
  return window?.type === "normal" && !window.incognito;
}

function groupKey(windowId) {
  return `dshGroup:${windowId}`;
}

async function syncWindow(window) {
  const key = groupKey(window.id);
  const { [key]: saved } = await chrome.storage.session.get(key);
  const tabs = window.tabs;
  const dshTabs = tabs.filter((tab) => !tab.pinned && isDshTab(tab));
  const groups = await chrome.tabGroups.query({windowId: window.id});
  const ownedGroup = groups.find((group) => group.id === saved?.id);

  if (ownedGroup) {
    const departed = tabs.filter((tab) => tab.groupId === ownedGroup.id &&
      saved.tabIds.includes(tab.id) && !isDshTab(tab));
    if (departed.length) await chrome.tabs.ungroup(departed.map((tab) => tab.id));
  }

  if (!dshTabs.length) {
    if (saved) await chrome.storage.session.remove(key);
    return;
  }

  const dshIds = dshTabs.map((tab) => tab.id);
  // Chrome can assign a new group ID when restoring a browser session.
  const restoredGroup = groups.find((group) => group.title === GROUP_STYLE.title &&
    group.color === GROUP_STYLE.color &&
    dshTabs.some((tab) => tab.groupId === group.id) &&
    tabs.every((tab) => tab.groupId !== group.id || dshIds.includes(tab.id)));
  const existingGroup = ownedGroup ?? restoredGroup;
  let groupId = existingGroup?.id;

  if (groupId === undefined) {
    groupId = await chrome.tabs.group({tabIds: dshIds, createProperties: {windowId: window.id}});
  } else {
    const newcomers = dshTabs.filter((tab) => tab.groupId !== groupId);
    if (newcomers.length) {
      // Ungrouping the last departing tab can delete the old group.
      const stillExists = (await chrome.tabGroups.query({windowId: window.id}))
        .some((group) => group.id === groupId);
      groupId = stillExists
        ? await chrome.tabs.group({tabIds: newcomers.map((tab) => tab.id), groupId})
        : await chrome.tabs.group({tabIds: dshIds, createProperties: {windowId: window.id}});
    }
  }

  await chrome.storage.session.set({[key]: {id: groupId, tabIds: dshIds}});
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

async function openDsh(sourceTab) {
  const windows = await normalWindows();
  const currentWindow = windows.find((window) => window.id === sourceTab.windowId);
  if (!currentWindow) return;

  const currentTabs = currentWindow.tabs.filter(isDshTab);
  const candidates = currentTabs.length ? currentTabs : windows.flatMap((window) => window.tabs.filter(isDshTab));
  const target = candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (!target) {
    const tab = await chrome.tabs.create({windowId: currentWindow.id, url: DSH_URL, active: true});
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

chrome.action.onClicked.addListener((tab) => runInOrder(() => openDsh(tab)));
chrome.runtime.onInstalled.addListener(() => runInOrder(syncAllWindows));
chrome.runtime.onStartup.addListener(() => runInOrder(syncAllWindows));

chrome.tabs.onCreated.addListener((tab) => {
  if (isDshTab(tab)) runInOrder(() => syncWindowById(tab.windowId));
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  const changedMembership = change.groupId !== undefined || change.pinned !== undefined;
  // Cross-origin navigation may hide the new URL under the host permission.
  const changedAddress = change.url !== undefined || change.status === "complete";
  if (changedMembership || (changedAddress && (isDshTab(tab) || tab.groupId !== NO_GROUP))) {
    runInOrder(() => syncWindowById(tab.windowId));
  }
});
chrome.tabs.onAttached.addListener((_id, {newWindowId}) => runInOrder(() => syncWindowById(newWindowId)));
chrome.tabs.onDetached.addListener((_id, {oldWindowId}) => runInOrder(() => syncWindowById(oldWindowId)));
chrome.tabs.onRemoved.addListener((_id, {windowId, isWindowClosing}) => {
  if (!isWindowClosing) runInOrder(() => syncWindowById(windowId));
});
chrome.windows.onRemoved.addListener((windowId) => runInOrder(() => chrome.storage.session.remove(groupKey(windowId))));
