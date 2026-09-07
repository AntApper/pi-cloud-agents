/**
 * Bounded pagination for token-based AWS list APIs.
 *
 * Every list call in this repository goes through `iteratePages` or `collectPages` so that a
 * misbehaving endpoint (a token that never ends or repeats) or a cancelled operation cannot keep
 * the CLI, the extension, or the controller Lambda spinning.
 */

export const DEFAULT_MAX_PAGES = 100;

export interface PaginateOptions {
  /** Upper bound on pages fetched; exceeding it throws `PaginationLimitError`. */
  maxPages?: number;
  /** Checked before every page fetch; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

export interface PageSource<TPage, TToken = string> {
  /** Fetches one page; receives `undefined` for the first page. */
  fetchPage: (token: TToken | undefined) => Promise<TPage>;
  /** Returns the continuation token for the next page, or `undefined` when done. */
  nextToken: (page: TPage) => TToken | undefined | null;
}

export interface ItemPageSource<TPage, TItem, TToken = string> extends PageSource<TPage, TToken> {
  items: (page: TPage) => TItem[] | undefined;
}

export class PaginationLimitError extends Error {
  readonly code = "PAGINATION_LIMIT";
  readonly pages: number;

  constructor(pages: number) {
    super(
      `Pagination stopped after ${pages} page(s): the result set is larger than expected. Narrow the query or raise maxPages.`,
    );
    this.name = "PaginationLimitError";
    this.pages = pages;
  }
}

function isEndToken<TToken>(token: TToken | undefined | null): token is undefined | null {
  return token === undefined || token === null || token === "";
}

function sameToken<TToken>(a: TToken, b: TToken | undefined): boolean {
  if (b === undefined) return false;
  if (typeof a !== "object" || a === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Yields pages until the source stops returning a continuation token.
 * Stops with an error when the page cap is hit, the token repeats, or the signal aborts.
 */
export async function* iteratePages<TPage, TToken = string>(
  source: PageSource<TPage, TToken>,
  options: PaginateOptions = {},
): AsyncGenerator<TPage, void, undefined> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let token: TToken | undefined;
  let pages = 0;

  for (;;) {
    options.signal?.throwIfAborted();
    if (pages >= maxPages) {
      throw new PaginationLimitError(pages);
    }

    const page = await source.fetchPage(token);
    pages++;
    yield page;

    const next = source.nextToken(page);
    if (isEndToken(next)) {
      return;
    }
    if (sameToken(next, token)) {
      throw new Error(
        `Pagination stalled: the API returned the same continuation token twice after ${pages} page(s).`,
      );
    }
    token = next;
  }
}

/**
 * Concatenates the items of every page.
 */
export async function collectPages<TPage, TItem, TToken = string>(
  source: ItemPageSource<TPage, TItem, TToken>,
  options: PaginateOptions = {},
): Promise<TItem[]> {
  const collected: TItem[] = [];
  for await (const page of iteratePages(source, options)) {
    const items = source.items(page);
    if (items) {
      collected.push(...items);
    }
  }
  return collected;
}
