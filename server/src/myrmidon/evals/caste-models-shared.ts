// server/src/myrmidon/evals/caste-models-shared.ts
//
// 1.8 CASTE-MODEL-EVAL: constants shared by the ranking route, the apply
// route and the tests. Kept apart from caste-models.ts so test files can
// import the subject prefix without pulling the gateway call chain.

/** Run subject marker for ranking runs: `caste-model-eval:<modelName>`. */
export const CASTE_MODEL_EVAL_SUBJECT_PREFIX = "caste-model-eval:";
