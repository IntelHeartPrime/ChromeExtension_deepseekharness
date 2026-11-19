const assert = require("node:assert/strict");
const {readFileSync, existsSync} = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

const root = path.resolve(__dirname, "..");
const URL_HOME = "http://127.0.0.1:8765/";
const tab = (id, url = URL_HOME, extra = {}) => ({
  id, url, windowId: 1, groupId: -1, pinned: false, lastAccessed: id, ...extra,
});

// Model Chrome's tab/group lifecycle, including deleting empty groups and API snapshots.
function browser({tabs = [], groups = [], stored = {}, windows = [{id: 1}]} = {}) {
  const state = {tabs, groups, stored, created: [], focused: [], errors: []};
  const listeners = {};
  let nextGroup = 100;
  let nextTab = 1000;
  const clone = (value) => structuredClone(value);
  const event = (name) => ({addListener: (listener) => { listeners[name] = listener; }});
  const getTab = (id) => {
    const result = tabs.find((item) => item.id === id);
    if (!result) throw new Error("No such tab");
    return result;
  };
  const prune = () => {
    state.groups = state.groups.filter((group) => tabs.some((item) => item.groupId === group.id));
  };
  const getWindow = (id) => {
    const window = windows.find((item) => item.id === id);
    if (!window) throw new Error("No such window");
    return clone({type: "normal", incognito: false, ...window,
      tabs: tabs.filter((item) => item.windowId === id)});
  };
  const chrome = {
    action: {onClicked: event("click")},
    runtime: {onInstalled: event("installed"), onStartup: event("startup")},
    storage: {session: {
      get: async (key) => clone({[key]: stored[key]}),
      set: async (value) => Object.assign(stored, clone(value)),
      remove: async (key) => { delete stored[key]; },
    }},
    windows: {
      getAll: async () => windows.map((item) => getWindow(item.id)),
      get: async (id) => getWindow(id),
      update: async (id, properties) => { state.focused.push({id, ...properties}); },
      onRemoved: event("windowRemoved"),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async ({windowId}) => clone(state.groups.filter((group) => group.windowId === windowId)),
      update: async (id, properties) => {
        const group = state.groups.find((item) => item.id === id);
        if (!group) throw new Error("No such group");
        Object.assign(group, properties);
        return clone(group);
      },
    },
    tabs: {
      get: async (id) => clone(getTab(id)),
      create: async (properties) => {
        const created = tab(nextTab++, properties.url, properties);
        tabs.push(created);
        state.created.push(clone(created));
        return clone(created);
      },
      update: async (id, properties) => Object.assign(getTab(id), properties),
      group: async ({tabIds, groupId, createProperties}) => {
        if (groupId === undefined) {
          groupId = nextGroup++;
          state.groups.push({id: groupId, windowId: createProperties.windowId});
        } else if (!state.groups.some((item) => item.id === groupId)) {
          throw new Error("No such group");
        }
        for (const id of tabIds) getTab(id).groupId = groupId;
        prune();
        return groupId;
      },
      ungroup: async (ids) => {
        for (const id of ids) getTab(id).groupId = -1;
        prune();
      },
      onCreated: event("created"), onUpdated: event("updated"),
      onAttached: event("attached"), onDetached: event("detached"), onRemoved: event("removed"),
    },
  };
  const context = vm.createContext({chrome, URL, console: {
    warn: (...args) => state.errors.push(args.join(" ")),
  }});
  vm.runInContext(readFileSync(path.join(root, "background.js"), "utf8") +
    "\nglobalThis.flush = () => pendingWork;", context);
  return {state, async emit(name, ...args) {
    listeners[name](...args);
    await context.flush();
    assert.deepEqual(state.errors, []);
  }};
}

test("toolbar click opens and marks the local service, then reuses it", async () => {
  const b = browser({tabs: [tab(1, "https://example.com") ]});
  await b.emit("click", {windowId: 1});
  assert.equal(b.state.created.length, 1);
  assert.equal(b.state.created[0].url, URL_HOME);
  assert.equal(b.state.tabs[1].active, true);
  assert.equal(b.state.groups[0].title, "Session Exporter");
  assert.equal(b.state.groups[0].color, "yellow");
  await b.emit("click", {windowId: 1});
  assert.equal(b.state.created.length, 1);
  assert.equal(b.state.groups[0].collapsed, false);
});

test("install marks matching pages and pending navigation, keeping DSH separate", async () => {
  const b = browser({tabs: [tab(1), tab(2, URL_HOME + "sessions/abc"),
    tab(3, "about:blank", {pendingUrl: URL_HOME}),
    tab(4, "http://127.0.0.1:3080/", {groupId: 9}),
    tab(5, "http://localhost:8765/"), tab(6, "https://127.0.0.1:8765/")],
    groups: [{id: 9, windowId: 1, title: "DSH", color: "purple"}]});
  await b.emit("installed");
  const ids = b.state.tabs.map((item) => item.groupId);
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[0], ids[2]);
  assert.equal(ids[3], 9);
  assert.equal(ids[4], -1);
  assert.equal(ids[5], -1);
  assert.equal(b.state.groups.find((group) => group.id === 9).title, "DSH");
});

test("toolbar prefers the most recent local tab and expands its group", async () => {
  const b = browser({windows: [{id: 1}, {id: 2}],
    tabs: [tab(1), tab(2), tab(3, URL_HOME, {windowId: 2, lastAccessed: 999})]});
  await b.emit("installed");
  b.state.groups[0].collapsed = true;
  await b.emit("click", {windowId: 1});
  assert.equal(b.state.tabs[1].active, true);
  assert.equal(b.state.tabs[2].active, undefined);
  assert.equal(b.state.groups[0].collapsed, false);
  assert.equal(b.state.created.length, 0);
});

test("toolbar focuses another window containing an existing page", async () => {
  const b = browser({windows: [{id: 1}, {id: 2}], tabs: [tab(1, URL_HOME, {windowId: 2})]});
  await b.emit("click", {windowId: 1});
  assert.equal(b.state.tabs[0].active, true);
  assert.deepEqual(b.state.focused, [{id: 2, focused: true}]);
  assert.equal(b.state.created.length, 0);
});

test("new and navigated tabs receive automatic marks; departed tabs leave the group", async () => {
  const b = browser({tabs: [tab(1)]});
  await b.emit("created", b.state.tabs[0]);
  assert.notEqual(b.state.tabs[0].groupId, -1);
  b.state.tabs[0].url = "http://127.0.0.1:3080/";
  await b.emit("updated", 1, {url: b.state.tabs[0].url}, b.state.tabs[0]);
  assert.equal(b.state.tabs[0].groupId, -1);
  assert.deepEqual(b.state.stored, {});
  b.state.tabs[0].url = URL_HOME;
  await b.emit("updated", 1, {status: "complete"}, b.state.tabs[0]);
  assert.notEqual(b.state.tabs[0].groupId, -1);
});

test("an emptied old group is recreated when a new service tab arrives", async () => {
  const b = browser({tabs: [tab(1, "https://example.com", {groupId: 9}), tab(2)],
    groups: [{id: 9, windowId: 1, title: "Session Exporter", color: "yellow"}],
    stored: {"sessionExporterGroup:1": {id: 9, tabIds: [1]}}});
  await b.emit("installed");
  assert.equal(b.state.tabs[0].groupId, -1);
  assert.notEqual(b.state.tabs[1].groupId, 9);
  assert.equal(b.state.groups.length, 1);
});

test("restart adopts a restored group instead of creating a duplicate", async () => {
  const b = browser({tabs: [tab(1, URL_HOME, {groupId: 9})],
    groups: [{id: 9, windowId: 1, title: "Session Exporter", color: "yellow"}]});
  await b.emit("startup");
  assert.equal(b.state.groups.length, 1);
  assert.equal(b.state.stored["sessionExporterGroup:1"].id, 9);
});

test("pinned tabs remain pinned and can be focused; incognito tabs are excluded", async () => {
  const b = browser({windows: [{id: 1}, {id: 2, incognito: true}],
    tabs: [tab(1, URL_HOME, {pinned: true}), tab(2, URL_HOME, {windowId: 2})]});
  await b.emit("installed");
  await b.emit("click", {windowId: 1});
  assert.equal(b.state.groups.length, 0);
  assert.equal(b.state.tabs[0].pinned, true);
  assert.equal(b.state.tabs[0].active, true);
  assert.equal(b.state.tabs[1].groupId, -1);
});

test("moving a tab syncs both windows and closing a window clears its record", async () => {
  const b = browser({windows: [{id: 1}, {id: 2}], tabs: [tab(1)]});
  await b.emit("installed");
  Object.assign(b.state.tabs[0], {windowId: 2, groupId: -1});
  b.state.groups.length = 0;
  await b.emit("detached", 1, {oldWindowId: 1});
  await b.emit("attached", 1, {newWindowId: 2});
  assert.equal(b.state.stored["sessionExporterGroup:1"], undefined);
  assert.equal(b.state.groups[0].windowId, 2);
  await b.emit("windowRemoved", 2);
  assert.equal(b.state.stored["sessionExporterGroup:2"], undefined);
});

test("manifest ships every declared PNG at the correct size, with no popup", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, undefined);
  assert.ok(existsSync(path.join(root, manifest.background.service_worker)));
  for (const [size, filename] of Object.entries({...manifest.icons, ...manifest.action.default_icon})) {
    const png = readFileSync(path.join(root, filename));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});
