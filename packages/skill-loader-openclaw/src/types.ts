export interface OpenClawSkillMeta {
  name: string;
  description: string;
  "user-invocable"?: boolean;
  "disable-model-invocation"?: boolean;
  metadata?: {
    openclaw?: {
      os?: string[];
      homepage?: string;
      emoji?: string;
      requires?: {
        bins?: string[];
        anyBins?: string[];
        /** Each name must be set in `process.env` or as a same-key property on the `config` object passed to `loadOpenClawSkills`. */
        env?: string[];
        config?: string[];
      };
      primaryEnv?: string;
      always?: boolean;
    };
  };
}

export interface ParsedOpenClawSkill {
  meta: OpenClawSkillMeta;
  /** Markdown body after frontmatter, with `{baseDir}` replaced. */
  instructions: string;
  skillDir: string;
  eligible: boolean;
  skipReason?: string;
}

/** Optional hooks when using `discoverSkills` directly. */
export interface DiscoverSkillsOptions {
  /** Called when `SKILL.md` exists but parsing fails (e.g. invalid frontmatter). */
  onParseError?: (skillMdPath: string, error: unknown) => void;
}

export interface LoadOpenClawSkillsOptions {
  /** Skill parent directories to scan (subfolders contain `SKILL.md`). Precedence: earlier dirs win per skill `name`. */
  dirs: string[];
  config?: Record<string, unknown>;
  scope?: "global" | "project";
  projectId?: string;
  onSkipped?: (name: string, reason: string) => void;
  onLoaded?: (name: string) => void;
  /** Forwarded to {@link discoverSkills} for each entry in `dirs`. */
  onSkillParseError?: (skillMdPath: string, error: unknown) => void;
}

export interface LoadOpenClawSkillsResult {
  loaded: string[];
  skipped: { name: string; reason: string }[];
}
