// SEED TOOL DEFINITIONS — exported for explicit registration.
//
// IMPORTING THIS MODULE DOES NOT AUTO-REGISTER. The barrel
// (`@/lib/engine/tools`) is the single auto-registration point.
// Tests that need an isolated registry can reset the registry,
// import these definitions, and call `registerTool` themselves.

export { COMPUTE_MATH } from './compute-math';
export { PARSE_JSON } from './parse-json';
export { COMPUTE_TEXT_TRANSFORM } from './text-transform';
