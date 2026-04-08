import type {
  SkillDefinition,
  SkillDefinitionPersisted,
  SkillExecute,
} from "./types.js";
import { registerSkillDefinition } from "./registry.js";

function toSkillDefinition(
  def: SkillDefinitionPersisted | SkillDefinition,
  execute?: SkillExecute,
): SkillDefinition {
  const d = def as SkillDefinition;
  if (d.execute !== undefined) {
    return d;
  }
  if (execute !== undefined) {
    return { ...def, execute };
  }
  return d;
}

export class Skill {
  /**
   * Register a skill. In **source code**, put `execute` on `def` when needed.
   * The optional second argument is for **store JSON** (`SkillDefinitionPersisted`): attach `execute` from code when the row has no function. If `def` already has `execute`, the second argument is ignored.
   */
  static async define(
    def: SkillDefinitionPersisted | SkillDefinition,
    execute?: SkillExecute,
  ): Promise<void> {
    registerSkillDefinition(toSkillDefinition(def, execute));
  }

  /** After loading many rows from a store, `executes[id]` supplies `execute` only when that row has no `execute`. */
  static async defineBatch(
    items: (SkillDefinitionPersisted | SkillDefinition)[],
    executes: Partial<Record<string, SkillExecute>> = {},
  ): Promise<void> {
    for (const item of items) {
      registerSkillDefinition(toSkillDefinition(item, executes[item.id]));
    }
  }
}
