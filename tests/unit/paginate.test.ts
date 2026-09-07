import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PAGES,
  PaginationLimitError,
  collectPages,
  iteratePages,
} from "../../core/aws/paginate.js";

interface FakePage {
  items: string[];
  next?: string;
}

function pagedSource(pages: FakePage[]) {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    source: {
      fetchPage: async (token: string | undefined) => {
        calls.push(token);
        const index = token === undefined ? 0 : Number(token);
        const page = pages[index];
        if (!page) throw new Error(`no page for token ${token}`);
        return page;
      },
      nextToken: (page: FakePage) => page.next,
      items: (page: FakePage) => page.items,
    },
  };
}

describe("T5.10 bounded pagination helper", () => {
  it("walks every page and concatenates items, passing the previous token forward", async () => {
    const { source, calls } = pagedSource([
      { items: ["a", "b"], next: "1" },
      { items: ["c"], next: "2" },
      { items: ["d", "e"] },
    ]);

    const items = await collectPages(source);

    expect(items).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toEqual([undefined, "1", "2"]);
  });

  it("treats empty-string and null tokens as the end of the listing", async () => {
    const emptyString = await collectPages({
      fetchPage: async () => ({ items: [1], next: "" }),
      nextToken: (page) => page.next,
      items: (page) => page.items,
    });
    const nullToken = await collectPages({
      fetchPage: async () => ({ items: [2], next: null as string | null }),
      nextToken: (page) => page.next,
      items: (page) => page.items,
    });

    expect(emptyString).toEqual([1]);
    expect(nullToken).toEqual([2]);
  });

  it("stops with PaginationLimitError when the page cap is exceeded", async () => {
    let fetched = 0;
    const endless = {
      fetchPage: async (token: string | undefined) => {
        fetched++;
        return { items: [token ?? "start"], next: String(fetched) };
      },
      nextToken: (page: { next: string }) => page.next,
      items: (page: { items: string[] }) => page.items,
    };

    await expect(collectPages(endless, { maxPages: 5 })).rejects.toBeInstanceOf(
      PaginationLimitError,
    );
    expect(fetched).toBe(5);

    fetched = 0;
    await expect(collectPages(endless)).rejects.toThrow(/larger than expected/);
    expect(fetched).toBe(DEFAULT_MAX_PAGES);
  });

  it("detects an endpoint that repeats the same continuation token", async () => {
    const stuck = {
      fetchPage: async () => ({ items: ["x"], next: "same" }),
      nextToken: (page: { next: string }) => page.next,
      items: (page: { items: string[] }) => page.items,
    };

    await expect(collectPages(stuck)).rejects.toThrow(/Pagination stalled/);
  });

  it("compares structured tokens by value for the stall guard", async () => {
    let page = 0;
    const structured = {
      fetchPage: async (_token: { key?: string; version?: string } | undefined) => {
        page++;
        return { page, next: page < 3 ? { key: `k${page}`, version: `v${page}` } : undefined };
      },
      nextToken: (p: { next?: { key?: string; version?: string } }) => p.next,
    };

    const seen: number[] = [];
    for await (const p of iteratePages(structured)) {
      seen.push(p.page);
    }
    expect(seen).toEqual([1, 2, 3]);

    const repeating = {
      fetchPage: async () => ({ next: { key: "k", version: "v" } }),
      nextToken: (p: { next: { key: string; version: string } }) => p.next,
    };
    // The page fetched with the repeated token is still yielded; the stall is raised once its
    // own continuation token turns out to be identical.
    const gen = iteratePages(repeating);
    await gen.next();
    await gen.next();
    await expect(gen.next()).rejects.toThrow(/Pagination stalled/);
  });

  it("honours an AbortSignal between pages", async () => {
    const controller = new AbortController();
    let fetched = 0;
    const source = {
      fetchPage: async (token: string | undefined) => {
        fetched++;
        if (fetched === 2) controller.abort(new Error("cancelled by test"));
        return { items: [token ?? "0"], next: String(fetched) };
      },
      nextToken: (page: { next: string }) => page.next,
      items: (page: { items: string[] }) => page.items,
    };

    await expect(collectPages(source, { signal: controller.signal })).rejects.toThrow(
      "cancelled by test",
    );
    expect(fetched).toBe(2);
  });

  it("iteratePages lets callers act per page and stop early", async () => {
    const { source, calls } = pagedSource([
      { items: ["a"], next: "1" },
      { items: ["b"], next: "2" },
      { items: ["c"] },
    ]);

    const seen: string[] = [];
    for await (const page of iteratePages(source)) {
      seen.push(...page.items);
      if (page.items.includes("b")) break;
    }

    expect(seen).toEqual(["a", "b"]);
    expect(calls).toEqual([undefined, "1"]);
  });
});
