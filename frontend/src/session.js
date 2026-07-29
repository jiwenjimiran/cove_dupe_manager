const state = {
  rawGroups: null,
  searchSettings: null,
  query: "",
  page: 1,
  selectedIds: new Set(),
  deletion: null,
  dismissedGroupKeys: new Set(),
  stale: false,
};

export function getSession() {
  return state;
}

export function clearSession() {
  state.rawGroups = null;
  state.searchSettings = null;
  state.query = "";
  state.page = 1;
  state.selectedIds = new Set();
  state.deletion = null;
  state.dismissedGroupKeys = new Set();
  state.stale = false;
}
