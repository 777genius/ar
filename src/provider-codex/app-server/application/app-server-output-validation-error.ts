/** Finite diagnostics only. Raw validator exceptions never cross this boundary. */
export enum AppServerOutputValidationStage {
  Parse = "structured_parse",
  Normalize = "schema_normalization",
  Product = "product_validator",
  Unknown = "unknown_validator",
}
export enum AppServerOutputValidationCode {
  ParseFailed = "structured_parse_failed",
  NormalizeFailed = "schema_normalization_failed",
  ProductRejected = "product_validator_rejected",
  ProductException = "product_validator_exception",
  Unknown = "validator_exception",
}
export class AppServerOutputValidationError extends Error {
  constructor(
    readonly stage: AppServerOutputValidationStage,
    readonly validationCode: AppServerOutputValidationCode,
  ) {
    super("codex_goal_completed_output_rejected");
    this.name = "AppServerOutputValidationError";
  }
}

export async function validateAppServerCompletedOutput(input: {
  readonly text: string;
  readonly parse: (text: string) => unknown;
  readonly normalize: (value: unknown) => unknown;
  readonly validate: (value: unknown) => boolean | Promise<boolean>;
}): Promise<void> {
  let parsed: unknown;
  try { parsed = input.parse(input.text); } catch {
    throw new AppServerOutputValidationError(AppServerOutputValidationStage.Parse,
      AppServerOutputValidationCode.ParseFailed);
  }
  let normalized: unknown;
  try { normalized = input.normalize(parsed); } catch {
    throw new AppServerOutputValidationError(AppServerOutputValidationStage.Normalize,
      AppServerOutputValidationCode.NormalizeFailed);
  }
  let accepted: boolean;
  try { accepted = await input.validate(normalized); } catch {
    throw new AppServerOutputValidationError(AppServerOutputValidationStage.Product,
      AppServerOutputValidationCode.ProductException);
  }
  if (accepted !== true) throw new AppServerOutputValidationError(
    AppServerOutputValidationStage.Product, AppServerOutputValidationCode.ProductRejected);
}
