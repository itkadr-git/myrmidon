// server/src/myrmidon/intake-dialog/index.ts
//
// myrmidon(1.8 INTAKE-DIALOG / OPE-13010): dialogue clarification and customer confirmation.

export {
  INTAKE_CARD_DOCUMENT_KEY,
  intakeCardApprovalIdempotencyKey,
  getQuestionForMissingSection,
  processIntakeCard,
  intakeDialogService,
  type ClarificationQuestion,
  type IntakeDialogResult,
  type ProcessIntakeCardInput,
  type IntakeDialogDeps,
} from "./service.js";
