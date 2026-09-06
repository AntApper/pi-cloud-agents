/**
 * Terminal readline implementation of Prompter (T4.3a).
 */

import readline from "node:readline/promises";
import type {
  InputOptions,
  MultiSelectOption,
  PasswordOptions,
  Prompter,
  SelectOption,
} from "../core/prompter.js";

export class TerminalPrompter implements Prompter {
  private createRl(): readline.Interface {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async select<T>(message: string, options: SelectOption<T>[], defaultValue?: T): Promise<T> {
    const rl = this.createRl();
    try {
      console.log(`\n${message}`);
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!;
        const hint = opt.hint ? ` (${opt.hint})` : "";
        console.log(`  ${i + 1}. ${opt.label}${hint}`);
      }

      let defaultIndex = 1;
      if (defaultValue !== undefined) {
        const idx = options.findIndex((o) => o.value === defaultValue);
        if (idx >= 0) defaultIndex = idx + 1;
      }

      while (true) {
        const answer = await rl.question(
          `Select option [1-${options.length}] (default ${defaultIndex}): `,
        );
        const trimmed = answer.trim();
        if (!trimmed) {
          return options[defaultIndex - 1]!.value;
        }
        const num = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
          return options[num - 1]!.value;
        }
        console.log(`Please enter a number between 1 and ${options.length}.`);
      }
    } finally {
      rl.close();
    }
  }

  async multiselect<T>(message: string, options: MultiSelectOption<T>[]): Promise<T[]> {
    const rl = this.createRl();
    try {
      console.log(`\n${message}`);
      const selected = new Set<number>();
      for (let i = 0; i < options.length; i++) {
        if (options[i]!.selected) {
          selected.add(i);
        }
      }

      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!;
        const mark = selected.has(i) ? "[x]" : "[ ]";
        const hint = opt.hint ? ` (${opt.hint})` : "";
        console.log(`  ${mark} ${i + 1}. ${opt.label}${hint}`);
      }

      const defaultStr =
        selected.size > 0
          ? Array.from(selected)
              .map((i) => i + 1)
              .join(",")
          : "none";
      const answer = await rl.question(
        `Enter comma-separated numbers to select/toggle (Enter to accept default '${defaultStr}'): `,
      );
      const trimmed = answer.trim();

      if (!trimmed) {
        return Array.from(selected).map((i) => options[i]!.value);
      }

      const chosenIndices = trimmed
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n >= 1 && n <= options.length)
        .map((n) => n - 1);

      return chosenIndices.map((i) => options[i]!.value);
    } finally {
      rl.close();
    }
  }

  async confirm(message: string, defaultValue = true): Promise<boolean> {
    const rl = this.createRl();
    try {
      const hint = defaultValue ? "[Y/n]" : "[y/N]";
      while (true) {
        const answer = await rl.question(`${message} ${hint}: `);
        const trimmed = answer.trim().toLowerCase();
        if (!trimmed) return defaultValue;
        if (trimmed === "y" || trimmed === "yes") return true;
        if (trimmed === "n" || trimmed === "no") return false;
        console.log("Please enter 'y' or 'n'.");
      }
    } finally {
      rl.close();
    }
  }

  async input(message: string, options?: InputOptions): Promise<string> {
    const rl = this.createRl();
    try {
      const defaultHint = options?.defaultValue ? ` (default: ${options.defaultValue})` : "";
      while (true) {
        const answer = await rl.question(`${message}${defaultHint}: `);
        const val = answer.trim() || options?.defaultValue || "";
        if (options?.validate) {
          const res = await options.validate(val);
          if (typeof res === "string") {
            console.log(`Error: ${res}`);
            continue;
          }
          if (!res) {
            console.log("Validation failed.");
            continue;
          }
        }
        return val;
      }
    } finally {
      rl.close();
    }
  }

  async password(message: string, options?: PasswordOptions): Promise<string> {
    const rl = this.createRl();
    try {
      while (true) {
        const answer = await rl.question(`${message}: `);
        const val = answer.trim();
        if (options?.validate) {
          const res = await options.validate(val);
          if (typeof res === "string") {
            console.log(`Error: ${res}`);
            continue;
          }
        }
        return val;
      }
    } finally {
      rl.close();
    }
  }

  note(message: string, title?: string): void {
    if (title) {
      console.log(`\n--- ${title} ---`);
    }
    console.log(message);
  }

  async progress<T>(
    title: string,
    task: (update: (msg: string) => void) => Promise<T>,
  ): Promise<T> {
    console.log(`[setup] ${title}...`);
    const update = (msg: string) => {
      console.log(`  -> ${msg}`);
    };
    return task(update);
  }
}
