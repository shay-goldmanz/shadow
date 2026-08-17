import {
  runSessionStoreContractTests,
  type SessionStoreHarness,
} from "./session-store.contract.ts";
import { InMemorySessionStore } from "./test-helpers.ts";

async function makeHarness(): Promise<SessionStoreHarness> {
  return {
    store: new InMemorySessionStore(),
    cleanup: () => Promise.resolve(),
  };
}

runSessionStoreContractTests("InMemorySessionStore", makeHarness);
