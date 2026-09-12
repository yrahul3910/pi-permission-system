import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  processForwardedPermissionRequests,
  setExtensionConfig,
} from "../src/index.js";
import { DEFAULT_EXTENSION_CONFIG } from "../src/extension-config.js";
import { requestPermissionDecisionFromUi } from "../src/permission-dialog.js";
import {
  createPermissionForwardingLocation,
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PERMISSION_FORWARDING_TIMEOUT_MS,
} from "../src/permission-forwarding.js";
import { runAsyncTest } from "./test-harness.js";

function unexpectedUiCall(): never {
  throw new Error("Unexpected UI operation");
}

function createForwardingCase() {
  const directory = mkdtempSync(join(tmpdir(), "pi-forwarding-lifetime-"));
  const previousAgentDir = process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY];
  process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY] = directory;
  const location = createPermissionForwardingLocation(
    join(directory, "sessions", "permission-forwarding"),
    "parent",
  );
  mkdirSync(location.requestsDir, { recursive: true });
  mkdirSync(location.responsesDir, { recursive: true });
  const requestPath = join(location.requestsDir, "lifetime.json");
  const responsePath = join(location.responsesDir, "lifetime.json");
  const shown: string[] = [];
  let answer: (value: string) => void = unexpectedUiCall;
  const context: ExtensionContext = {
    cwd: directory,
    hasUI: true,
    model: undefined,
    modelRegistry: undefined,
    abort: unexpectedUiCall,
    getSystemPrompt: () => "",
    sessionManager: {
      getSessionId: () => "parent",
      getSessionDir: () => directory,
      getEntries: () => [],
    },
    ui: {
      select: (title) => {
        shown.push(title);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      input: unexpectedUiCall,
      confirm: unexpectedUiCall,
      custom: unexpectedUiCall,
      notify: unexpectedUiCall,
      setStatus: unexpectedUiCall,
      setWorkingMessage: unexpectedUiCall,
    },
  };
  return {
    context,
    shown,
    requestPath,
    responsePath,
    answer: (value: string) => answer(value),
    writeRequest: (remainingMs: number) =>
      writeFileSync(
        requestPath,
        JSON.stringify({
          id: "lifetime",
          responseNonce: "lifetime-nonce",
          createdAt:
            Date.now() - PERMISSION_FORWARDING_TIMEOUT_MS + remainingMs,
          requesterSessionId: "child",
          targetSessionId: "parent",
          requesterAgentName: "Explore",
          message: "Allow find?",
        }),
      ),
    cleanup: () => {
      if (previousAgentDir === undefined) {
        delete process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY];
      } else {
        process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY] = previousAgentDir;
      }
      setExtensionConfig(DEFAULT_EXTENSION_CONFIG);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const configuredTimeout of [null, 30]) {
  await runAsyncTest(
    `forwarded lifetime caps a queued dialog with timeout ${configuredTimeout}`,
    async () => {
      const test = createForwardingCase();
      try {
        setExtensionConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          desktopNotifications: false,
          forwardedPromptTimeoutSeconds: configuredTimeout,
        });
        test.writeRequest(100);
        const local = requestPermissionDecisionFromUi(
          test.context.ui,
          "Local",
          "read",
        );
        let processed = false;
        const scan = processForwardedPermissionRequests(test.context, {
          preserveLocation: true,
        }).then(() => {
          processed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(
          processed,
          true,
          "expired forwarded request must stop waiting for the local dialog",
        );
        assert.equal(
          existsSync(test.responsePath),
          false,
          "expired requests must not leave orphan responses",
        );
        assert.equal(existsSync(test.requestPath), false);
        assert.deepEqual(test.shown, ["Local\nread"]);
        test.answer("Allow Once");
        await local;
        await scan;
        const next = requestPermissionDecisionFromUi(
          test.context.ui,
          "Next",
          "write",
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(test.shown, ["Local\nread", "Next\nwrite"]);
        test.answer("Allow Once");
        await next;
      } finally {
        test.cleanup();
      }
    },
  );
}

await runAsyncTest(
  "a forwarded decision is discarded when the requester has removed its request",
  async () => {
    const test = createForwardingCase();
    try {
      setExtensionConfig({
        ...DEFAULT_EXTENSION_CONFIG,
        desktopNotifications: false,
      });
      test.writeRequest(PERMISSION_FORWARDING_TIMEOUT_MS);
      test.context.ui.select = async () => {
        rmSync(test.requestPath);
        return "Allow Once";
      };
      await processForwardedPermissionRequests(test.context, {
        preserveLocation: true,
      });
      assert.equal(existsSync(test.responsePath), false);
    } finally {
      test.cleanup();
    }
  },
);

await runAsyncTest(
  "an approval arriving after the forwarding deadline leaves no response",
  async () => {
    const test = createForwardingCase();
    const originalNow = Date.now;
    try {
      setExtensionConfig({
        ...DEFAULT_EXTENSION_CONFIG,
        desktopNotifications: false,
      });
      test.writeRequest(1_000);
      test.context.ui.select = async () => {
        const expiredAt = originalNow() + 2_000;
        Date.now = () => expiredAt;
        return "Allow Once";
      };
      await processForwardedPermissionRequests(test.context, {
        preserveLocation: true,
      });
      assert.equal(existsSync(test.responsePath), false);
      assert.equal(existsSync(test.requestPath), false);
    } finally {
      Date.now = originalNow;
      test.cleanup();
    }
  },
);

for (const configuredTimeout of [null, 30]) {
  await runAsyncTest(
    `a manual forwarded rejection with timeout ${configuredTimeout} has no expiry reason`,
    async () => {
      const test = createForwardingCase();
      try {
        setExtensionConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          desktopNotifications: false,
          forwardedPromptTimeoutSeconds: configuredTimeout,
        });
        test.writeRequest(PERMISSION_FORWARDING_TIMEOUT_MS);
        test.context.ui.select = async () => "Reject";
        await processForwardedPermissionRequests(test.context, {
          preserveLocation: true,
        });
        const response = readFileSync(test.responsePath, "utf8");
        assert.match(response, /"approved":\s*false/);
        assert.match(response, /"state":\s*"reject"/);
        assert.doesNotMatch(response, /"denialReason"/);
        assert.equal(existsSync(test.requestPath), false);
      } finally {
        test.cleanup();
      }
    },
  );
}

await runAsyncTest(
  "a response published after the deadline is removed",
  async () => {
    const test = createForwardingCase();
    const originalNow = Date.now;
    const startedAt = originalNow();
    // Advance the clock as soon as the real atomic write publishes the response.
    Date.now = () =>
      existsSync(test.responsePath) ? startedAt + 2_000 : startedAt;
    try {
      setExtensionConfig({
        ...DEFAULT_EXTENSION_CONFIG,
        desktopNotifications: false,
      });
      test.writeRequest(1_000);
      test.context.ui.select = async () => "Allow Once";
      await processForwardedPermissionRequests(test.context, {
        preserveLocation: true,
      });
      assert.equal(existsSync(test.responsePath), false);
      assert.equal(existsSync(test.requestPath), false);
    } finally {
      Date.now = originalNow;
      test.cleanup();
    }
  },
);
