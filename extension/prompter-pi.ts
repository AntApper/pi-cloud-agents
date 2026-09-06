/**
 * pi TUI/UI Adapter for Prompter (T4.3a).
 */

import type {
  InputOptions,
  MultiSelectOption,
  PasswordOptions,
  Prompter,
  SelectOption,
} from "../core/prompter.js";

export interface PiUiContext {
  hasUI?: boolean;
  mode?: "tui" | "rpc" | string;
  ui?: {
    select?: unknown;
    confirm?: unknown;
    input?: unknown;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (id: string, text: string) => void;
    setWidget?: (id: string, widget?: string[] | unknown, options?: unknown) => void;
    setFooter?: (content: unknown) => void;
    custom?: unknown;
  };
  newSession?: (options?: { name?: string; [key: string]: unknown }) => Promise<
    PiUiContext | undefined
  >;
  switchSession?: (pathOrId?: string) => Promise<PiUiContext | undefined>;
  session?: {
    id?: string;
    name?: string;
    path?: string;
    [key: string]: unknown;
  };
  modelRegistry?: unknown;
}

export class PiPrompter implements Prompter {
  private readonly ctx: PiUiContext;

  constructor(ctx: PiUiContext = {}) {
    this.ctx = ctx;
  }

  async select<T>(message: string, options: SelectOption<T>[], defaultValue?: T): Promise<T> {
    if (
      this.ctx.hasUI &&
      this.ctx.ui &&
      typeof (this.ctx.ui as { select?: unknown }).select === "function"
    ) {
      const selectFn = (
        this.ctx.ui as { select: (title: string, opts: unknown) => Promise<unknown> }
      ).select;
      const res = await selectFn(message, options);
      if (res !== undefined) {
        if (options.some((o) => o.value === res)) return res as T;
        const match = options.find((o) => o.label === res || o.value === (res as unknown));
        if (match) return match.value;
      }
    }
    if (defaultValue !== undefined) return defaultValue;
    if (options.length > 0) return options[0]!.value;
    throw new Error(`Cannot prompt select: no UI available for '${message}'`);
  }

  async multiselect<T>(_message: string, options: MultiSelectOption<T>[]): Promise<T[]> {
    // In basic pi UI mode, select all pre-selected by default or prompt sequentially
    return options.filter((o) => o.selected).map((o) => o.value);
  }

  async confirm(message: string, defaultValue = true): Promise<boolean> {
    if (
      this.ctx.hasUI &&
      this.ctx.ui &&
      typeof (this.ctx.ui as { confirm?: unknown }).confirm === "function"
    ) {
      const confirmFn = (
        this.ctx.ui as { confirm: (title: string, def?: boolean) => Promise<boolean> }
      ).confirm;
      return confirmFn(message, defaultValue);
    }
    return defaultValue;
  }

  async input(message: string, options?: InputOptions): Promise<string> {
    if (
      this.ctx.hasUI &&
      this.ctx.ui &&
      typeof (this.ctx.ui as { input?: unknown }).input === "function"
    ) {
      const inputFn = (this.ctx.ui as { input: (title: string, def?: string) => Promise<string> })
        .input;
      const val = await inputFn(message, options?.defaultValue);
      if (options?.validate) {
        const res = await options.validate(val);
        if (typeof res === "string") throw new Error(res);
      }
      return val;
    }
    return options?.defaultValue ?? "";
  }

  async password(message: string, options?: PasswordOptions): Promise<string> {
    if (
      this.ctx.hasUI &&
      this.ctx.ui &&
      typeof (this.ctx.ui as { input?: unknown }).input === "function"
    ) {
      const inputFn = (this.ctx.ui as { input: (title: string) => Promise<string> }).input;
      const val = await inputFn(message);
      if (options?.validate) {
        const res = await options.validate(val);
        if (typeof res === "string") throw new Error(res);
      }
      return val;
    }
    return "";
  }

  note(message: string, _title?: string): void {
    if (this.ctx.hasUI && this.ctx.ui?.notify) {
      this.ctx.ui.notify(message, "info");
    }
  }

  async progress<T>(
    _title: string,
    task: (update: (msg: string) => void) => Promise<T>,
  ): Promise<T> {
    const update = (msg: string) => {
      if (this.ctx.hasUI && this.ctx.ui?.notify) {
        this.ctx.ui.notify(msg, "info");
      }
    };
    return task(update);
  }
}
