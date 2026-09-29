/**
 * Placeholder port between ELISE's core and any AI model runtime.
 * Implementations live in `src/infrastructure/ai/`. The shape is intentionally
 * minimal and will be defined by docs/architecture/12-agent-runtime.md.
 */
export interface AIProvider {
  readonly id: string;
}
