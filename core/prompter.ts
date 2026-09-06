/**
 * Prompter Abstraction Interface (T4.3a).
 * Unified interactive prompter used by the setup wizard, CLI, and pi TUI commands.
 */

export interface SelectOption<T = string> {
  label: string;
  value: T;
  hint?: string;
  description?: string;
}

export interface MultiSelectOption<T = string> extends SelectOption<T> {
  selected?: boolean;
}

export interface InputOptions {
  defaultValue?: string;
  placeholder?: string;
  validate?: (val: string) => string | boolean | Promise<string | boolean>;
}

export interface PasswordOptions {
  validate?: (val: string) => string | boolean | Promise<string | boolean>;
}

export interface Prompter {
  select<T>(message: string, options: SelectOption<T>[], defaultValue?: T): Promise<T>;
  multiselect<T>(message: string, options: MultiSelectOption<T>[]): Promise<T[]>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  input(message: string, options?: InputOptions): Promise<string>;
  password(message: string, options?: PasswordOptions): Promise<string>;
  note(message: string, title?: string): void | Promise<void>;
  progress<T>(title: string, task: (update: (msg: string) => void) => Promise<T>): Promise<T>;
}

/**
 * Scripted prompter for programmatic testing and automated scenarios.
 */
export class ScriptedPrompter implements Prompter {
  public selectResponses: unknown[] = [];
  public multiselectResponses: unknown[][] = [];
  public confirmResponses: boolean[] = [];
  public inputResponses: string[] = [];
  public passwordResponses: string[] = [];

  public recordedCalls: Array<{ method: string; message: string; payload?: unknown }> = [];
  public recordedNotes: Array<{ message: string; title?: string }> = [];
  public recordedProgress: string[] = [];

  constructor(
    options: {
      selectResponses?: unknown[];
      multiselectResponses?: unknown[][];
      confirmResponses?: boolean[];
      inputResponses?: string[];
      passwordResponses?: string[];
    } = {},
  ) {
    this.selectResponses = [...(options.selectResponses ?? [])];
    this.multiselectResponses = [...(options.multiselectResponses ?? [])];
    this.confirmResponses = [...(options.confirmResponses ?? [])];
    this.inputResponses = [...(options.inputResponses ?? [])];
    this.passwordResponses = [...(options.passwordResponses ?? [])];
  }

  async select<T>(message: string, options: SelectOption<T>[], defaultValue?: T): Promise<T> {
    this.recordedCalls.push({ method: "select", message, payload: options });
    if (this.selectResponses.length > 0) {
      return this.selectResponses.shift() as T;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    if (options.length > 0) {
      return options[0]!.value;
    }
    throw new Error(`ScriptedPrompter: No response available for select('${message}')`);
  }

  async multiselect<T>(message: string, options: MultiSelectOption<T>[]): Promise<T[]> {
    this.recordedCalls.push({ method: "multiselect", message, payload: options });
    if (this.multiselectResponses.length > 0) {
      return this.multiselectResponses.shift() as T[];
    }
    return options.filter((o) => o.selected).map((o) => o.value);
  }

  async confirm(message: string, defaultValue = true): Promise<boolean> {
    this.recordedCalls.push({ method: "confirm", message, payload: defaultValue });
    if (this.confirmResponses.length > 0) {
      return this.confirmResponses.shift()!;
    }
    return defaultValue;
  }

  async input(message: string, options?: InputOptions): Promise<string> {
    this.recordedCalls.push({ method: "input", message, payload: options });
    if (this.inputResponses.length > 0) {
      const resp = this.inputResponses.shift()!;
      if (options?.validate) {
        const valid = await options.validate(resp);
        if (typeof valid === "string") throw new Error(valid);
        if (!valid) throw new Error(`Validation failed for input('${message}')`);
      }
      return resp;
    }
    return options?.defaultValue ?? "";
  }

  async password(message: string, options?: PasswordOptions): Promise<string> {
    this.recordedCalls.push({ method: "password", message, payload: options });
    if (this.passwordResponses.length > 0) {
      const resp = this.passwordResponses.shift()!;
      if (options?.validate) {
        const valid = await options.validate(resp);
        if (typeof valid === "string") throw new Error(valid);
        if (!valid) throw new Error(`Validation failed for password('${message}')`);
      }
      return resp;
    }
    return "";
  }

  note(message: string, title?: string): void {
    this.recordedNotes.push({ message, title });
    this.recordedCalls.push({ method: "note", message, payload: title });
  }

  async progress<T>(
    title: string,
    task: (update: (msg: string) => void) => Promise<T>,
  ): Promise<T> {
    this.recordedProgress.push(title);
    this.recordedCalls.push({ method: "progress", message: title });
    const update = (msg: string) => {
      this.recordedProgress.push(`${title}: ${msg}`);
    };
    return task(update);
  }
}
