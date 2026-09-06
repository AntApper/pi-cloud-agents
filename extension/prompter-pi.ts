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
    select?: <T>(title: string, options: Array<{ label: string; value: T }>) => Promise<T>;
    confirm?: (title: string, defaultVal?: boolean) => Promise<boolean>;
    input?: (title: string, defaultVal?: string) => Promise<string>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (id: string, text: string) => void;
  };
}

export class PiPrompter implements Prompter {
  private readonly ctx: PiUiContext;

  constructor(ctx: PiUiContext = {}) {
    this.ctx = ctx;
  }

  async select<T>(message: string, options: SelectOption<T>[], defaultValue?: T): Promise<T> {
    if (this.ctx.hasUI && this.ctx.ui?.select) {
      return this.ctx.ui.select(message, options);
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
    if (this.ctx.hasUI && this.ctx.ui?.confirm) {
      return this.ctx.ui.confirm(message, defaultValue);
    }
    return defaultValue;
  }

  async input(message: string, options?: InputOptions): Promise<string> {
    if (this.ctx.hasUI && this.ctx.ui?.input) {
      const val = await this.ctx.ui.input(message, options?.defaultValue);
      if (options?.validate) {
        const res = await options.validate(val);
        if (typeof res === "string") throw new Error(res);
      }
      return val;
    }
    return options?.defaultValue ?? "";
  }

  async password(message: string, options?: PasswordOptions): Promise<string> {
    if (this.ctx.hasUI && this.ctx.ui?.input) {
      const val = await this.ctx.ui.input(message);
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
      if (this.ctx.hasUI && this.ctx.ui?.setStatus) {
        this.ctx.ui.setStatus("setup_progress", msg);
      }
    };
    return task(update);
  }
}
