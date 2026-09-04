// Domain-split api surface (maintenance refactor step 2). One barrel:
// call sites keep importing { api, ... } from "../api".
import * as feeds from "./feeds";
import * as search from "./search";
import * as bookmarks from "./bookmarks";
import * as follow from "./follow";
import * as illust from "./illust";
import * as prefs from "./prefs";
import * as auth from "./auth";

export const api = {
  ...feeds,
  ...search,
  ...bookmarks,
  ...follow,
  ...illust,
  ...prefs,
  ...auth,
};

export { logEvent, setOnGateLocked, setOnRequestError } from "./client";
