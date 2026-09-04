// Barrel over src/api/ (split by domain, step 2 of the maintenance
// refactor). Call sites keep importing from "./api". NOTE: the explicit
// "./api/index" is deliberate — "./api" here would resolve to THIS file
// (api.ts beats api/ in TS resolution) and self-import nothing.
export * from "./api/index";
