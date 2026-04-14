import assert from "node:assert/strict";
import test from "node:test";

import {
  NotionClient,
  normalizeNotionId,
  type NotionClientOptions,
} from "./notion-client.js";

test("updatePage sends in_trash without archived for the pinned Notion version", async () => {
  const fetchCalls = createFetchSpy([
    {
      object: "page",
      id: "page-id",
      url: "https://notion.so/page-id",
      parent: {
        type: "data_source_id",
        data_source_id: "data-source-id",
      },
      properties: {},
    },
  ]);
  const client = createClient(fetchCalls.fetch);

  await client.updatePage("page-id", {
    inTrash: true,
  });

  assert.equal(fetchCalls.calls.length, 1);
  assert.equal(fetchCalls.calls[0].path, "/v1/pages/page-id");
  assert.deepEqual(fetchCalls.calls[0].body, {
    in_trash: true,
  });
  assert.ok(!("archived" in fetchCalls.calls[0].body));
});

test("appendBlockChildren serializes after-block positioning via the new position object", async () => {
  const fetchCalls = createFetchSpy([
    {
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    },
  ]);
  const client = createClient(fetchCalls.fetch);

  await client.appendBlockChildren("parent-block-id", {
    children: [
      {
        object: "block",
        type: "paragraph",
      },
    ],
    position: {
      type: "after_block",
      afterBlockId: "anchor-block-id",
    },
  });

  assert.equal(fetchCalls.calls.length, 1);
  assert.equal(fetchCalls.calls[0].path, "/v1/blocks/parent-block-id/children");
  assert.deepEqual(fetchCalls.calls[0].body, {
    children: [
      {
        object: "block",
        type: "paragraph",
      },
    ],
    position: {
      type: "after_block",
      after_block: {
        id: "anchor-block-id",
      },
    },
  });
});

test("appendBlockChildren omits position when using the default end placement", async () => {
  const fetchCalls = createFetchSpy([
    {
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    },
  ]);
  const client = createClient(fetchCalls.fetch);

  await client.appendBlockChildren("parent-block-id", {
    children: [],
  });

  assert.equal(fetchCalls.calls.length, 1);
  assert.deepEqual(fetchCalls.calls[0].body, {
    children: [],
  });
});

test("retrievePageMarkdown targets the markdown endpoint and preserves query flags", async () => {
  const fetchCalls = createFetchSpy([
    {
      object: "page_markdown",
      id: "page-id",
      markdown: "# Context",
      truncated: false,
      unknown_block_ids: [],
    },
  ]);
  const client = createClient(fetchCalls.fetch);

  const response = await client.retrievePageMarkdown("page-id", {
    includeTranscript: true,
  });

  assert.equal(fetchCalls.calls.length, 1);
  assert.equal(fetchCalls.calls[0].path, "/v1/pages/page-id/markdown");
  assert.equal(fetchCalls.calls[0].query, "include_transcript=true");
  assert.equal(response.markdown, "# Context");
  assert.equal(response.truncated, false);
});

test("updatePageMarkdown serializes replace_content requests", async () => {
  const fetchCalls = createFetchSpy([
    {
      object: "page_markdown",
      id: "page-id",
      markdown: "# Context\n\nUpdated",
      truncated: false,
      unknown_block_ids: [],
    },
  ]);
  const client = createClient(fetchCalls.fetch);

  await client.updatePageMarkdown("page-id", {
    type: "replace_content",
    newString: "# Context\n\nUpdated",
  });

  assert.equal(fetchCalls.calls.length, 1);
  assert.equal(fetchCalls.calls[0].path, "/v1/pages/page-id/markdown");
  assert.deepEqual(fetchCalls.calls[0].body, {
    type: "replace_content",
    replace_content: {
      new_str: "# Context\n\nUpdated",
    },
  });
});

test("normalizeNotionId converts compact ids to dashed lowercase uuids", () => {
  assert.equal(
    normalizeNotionId("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
});

function createClient(fetcher: typeof fetch) {
  const options: NotionClientOptions = {
    authToken: "notion-token",
    fetcher,
  };

  return new NotionClient(options);
}

function createFetchSpy(responses: unknown[]) {
  const queue = [...responses];
  const calls: Array<{
    method: string;
    path: string;
    query: string;
    body: Record<string, unknown>;
  }> = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body =
      init?.body === undefined
        ? {}
        : (JSON.parse(String(init.body)) as Record<string, unknown>);

    calls.push({
      method: init?.method ?? "GET",
      path: new URL(url).pathname,
      query: new URL(url).searchParams.toString(),
      body,
    });

    return new Response(JSON.stringify(queue.shift() ?? {}), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  };

  return { calls, fetch };
}
