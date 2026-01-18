// packages/authz/src/index.ts

export * from "./core.js";

// IMPORTANT: do NOT export grants from the root,
// or every import of "@wasit/authz" drags AWS SDK into all lambdas.
