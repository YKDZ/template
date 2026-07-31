export type CliJourneyMode = "source" | "distribution" | "packed";

export type CliJourneyCommand = {
  readonly name: string;
  readonly args: readonly string[];
  /** Runs a prepared consumer command instead of the CLI under journey test. */
  readonly executable?: string | undefined;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  prepare?(context: CliJourneyContext): Promise<void>;
};

export type CliJourneyResult = {
  readonly commandName: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CliJourneyContext = {
  readonly mode: CliJourneyMode;
  readonly packageRoot: string;
  readonly workDir: string;
};

export type CliJourney = {
  readonly name: string;
  readonly modes: readonly CliJourneyMode[];
  setup(context: CliJourneyContext): Promise<void>;
  commands(context: CliJourneyContext): readonly CliJourneyCommand[];
  assertions(options: {
    readonly context: CliJourneyContext;
    readonly results: readonly CliJourneyResult[];
  }): Promise<void>;
};
