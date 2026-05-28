// Hermetic unit test — per-mold extractor prompt assembly.
//
// Tests the four PROMPT BUILDERS, not the LLM output. Given a sample
// (intent, optional answers, optional refinements), each builder
// must produce a prompt that contains:
//
//   - The engine's SPEC_QUALITY_BAR base bullets + that mold's
//     addendum bullets (in the SYSTEM prompt, via the
//     specQualityBarPromptBullets helper).
//   - The USER INTENT verbatim.
//   - The relevant CATALOG SLICE (tool registry for agent,
//     coordination patterns for system, field types for software,
//     resource types for infra).
//   - A schema reference.
//   - A mold-specific WORKED EXEMPLAR.
//
// Repair messages re-assert the bar. Stubbed: nothing — these are
// pure functions over already-validated structs.

import { describe, expect, it } from 'vitest';
import {
  SPEC_SYSTEM_PROMPT,
  buildExtractionUserMessage,
  buildRepairUserMessage,
} from '@/lib/engine/spec/prompts';
import {
  SYSTEM_SPEC_SYSTEM_PROMPT,
  buildSystemExtractionUserMessage,
  buildSystemRepairUserMessage,
} from '@/lib/engine/system/prompts';
import {
  SOFTWARE_SPEC_SYSTEM_PROMPT,
  buildSoftwareExtractionUserMessage,
  buildSoftwareRepairUserMessage,
} from '@/lib/engine/software/prompts';
import {
  INFRA_SPEC_SYSTEM_PROMPT,
  buildInfraExtractionUserMessage,
  buildInfraRepairUserMessage,
} from '@/lib/engine/infra/prompts';
import {
  SPEC_QUALITY_BAR,
  AGENT_SPEC_ADDENDUM,
  specQualityBarPromptBullets,
  SPEC_QUALITY_BAR_VERSION,
} from '@/lib/engine/spec/quality';
import {
  SYSTEM_SPEC_ADDENDUM,
} from '@/lib/engine/system/spec-quality';
import {
  SOFTWARE_SPEC_ADDENDUM,
} from '@/lib/engine/software/spec-quality';
import {
  INFRA_SPEC_ADDENDUM,
} from '@/lib/engine/infra/spec-quality';

// ===========================================================================
// AGENT
// ===========================================================================
describe('AGENT extractor system prompt', () => {
  it('embeds every base SPEC_QUALITY_BAR criterion', () => {
    for (const c of SPEC_QUALITY_BAR) {
      expect(SPEC_SYSTEM_PROMPT).toContain(c.label);
      expect(SPEC_SYSTEM_PROMPT).toContain(c.imperative);
    }
  });

  it('embeds every AGENT addendum criterion', () => {
    for (const c of AGENT_SPEC_ADDENDUM) {
      expect(SPEC_SYSTEM_PROMPT).toContain(c.label);
      expect(SPEC_SYSTEM_PROMPT).toContain(c.imperative);
    }
  });

  it('reproduces specQualityBarPromptBullets("agent") verbatim', () => {
    expect(SPEC_SYSTEM_PROMPT).toContain(specQualityBarPromptBullets('agent'));
  });

  it('advertises the bar version label', () => {
    expect(SPEC_SYSTEM_PROMPT).toContain('base v' + SPEC_QUALITY_BAR_VERSION);
    expect(SPEC_SYSTEM_PROMPT).toContain('agent addendum v');
  });

  it('forbids placeholders explicitly', () => {
    expect(SPEC_SYSTEM_PROMPT).toMatch(/TBD/);
    expect(SPEC_SYSTEM_PROMPT).toMatch(/placeholder/);
  });
});

describe('AGENT extractor user message', () => {
  const message = buildExtractionUserMessage({
    rawPrompt: 'Every morning fetch a URL and email me a brief.',
  });

  it('surfaces the intent verbatim', () => {
    expect(message).toContain('USER INTENT (verbatim):');
    expect(message).toContain('Every morning fetch a URL and email me a brief.');
  });

  it('contains the TOOL REGISTRY catalog slice with registry ids', () => {
    expect(message).toMatch(/TOOL REGISTRY/);
    expect(message).toMatch(/http_request/);
    expect(message).toMatch(/llm_completion/);
    expect(message).toMatch(/email_send/);
  });

  it('contains the WORKED EXEMPLAR with a do-not-copy disclaimer', () => {
    expect(message).toMatch(/WORKED EXEMPLAR.*DO NOT COPY VERBATIM/);
    expect(message).toContain('HN Morning Brief');
    expect(message).not.toMatch(/\bTODO\b/);
  });

  it('closes with the PRODUCE THE EXTRACTION NOW instruction', () => {
    expect(message).toContain('PRODUCE THE EXTRACTION NOW');
    expect(message).toMatch(/No prose\. No fences\./);
  });

  it('includes clarifications + refinements blocks when provided', () => {
    const m2 = buildExtractionUserMessage({
      rawPrompt: 'Watch a URL.',
      answers: [{ question: 'Which URL?', answer: 'https://example.com/feed' }],
      refinements: ['Run at 06:00 UTC instead of 09:00.'],
    });
    expect(m2).toContain('CLARIFICATIONS');
    expect(m2).toContain('Which URL?');
    expect(m2).toContain('https://example.com/feed');
    expect(m2).toContain('USER REFINEMENTS');
    expect(m2).toContain('Run at 06:00 UTC');
  });
});

describe('AGENT repair message re-asserts the bar', () => {
  it('echoes the parse error and references the SPEC QUALITY BAR', () => {
    const msg = buildRepairUserMessage('field "name": expected string');
    expect(msg).toContain('field "name": expected string');
    expect(msg).toMatch(/SPEC QUALITY BAR/);
  });
});

// ===========================================================================
// SYSTEM
// ===========================================================================
describe('SYSTEM extractor system prompt', () => {
  it('embeds every base + SYSTEM addendum criterion', () => {
    for (const c of SPEC_QUALITY_BAR) {
      expect(SYSTEM_SPEC_SYSTEM_PROMPT).toContain(c.label);
    }
    for (const c of SYSTEM_SPEC_ADDENDUM) {
      expect(SYSTEM_SPEC_SYSTEM_PROMPT).toContain(c.label);
      expect(SYSTEM_SPEC_SYSTEM_PROMPT).toContain(c.imperative);
    }
  });

  it('reproduces specQualityBarPromptBullets("system") verbatim', () => {
    expect(SYSTEM_SPEC_SYSTEM_PROMPT).toContain(specQualityBarPromptBullets('system'));
  });
});

describe('SYSTEM extractor user message', () => {
  const message = buildSystemExtractionUserMessage({
    rawPrompt: 'Three agents: scrape news, summarise, post to Slack.',
  });

  it('contains the COORDINATION pattern catalog slice', () => {
    expect(message).toMatch(/COORDINATION PATTERN CATALOG/);
    expect(message).toMatch(/pipeline/);
    expect(message).toMatch(/fan_out_in/);
    expect(message).toMatch(/dag/);
  });

  it('contains a system WORKED EXEMPLAR with named handoffs', () => {
    expect(message).toMatch(/WORKED EXEMPLAR/);
    // The system exemplar shows named payloads — not vague labels.
    expect(message).toContain('raw_conversations');
    expect(message).toContain('theme_counts');
    expect(message).not.toMatch(/\bTODO\b/);
  });
});

describe('SYSTEM repair message re-asserts the bar', () => {
  it('echoes the parse error and references the SPEC QUALITY BAR (system)', () => {
    const msg = buildSystemRepairUserMessage('coordination.pattern: required');
    expect(msg).toContain('coordination.pattern: required');
    expect(msg).toMatch(/SPEC QUALITY BAR.*system addendum/);
  });
});

// ===========================================================================
// SOFTWARE
// ===========================================================================
describe('SOFTWARE extractor system prompt', () => {
  it('embeds every base + SOFTWARE addendum criterion', () => {
    for (const c of SPEC_QUALITY_BAR) {
      expect(SOFTWARE_SPEC_SYSTEM_PROMPT).toContain(c.label);
    }
    for (const c of SOFTWARE_SPEC_ADDENDUM) {
      expect(SOFTWARE_SPEC_SYSTEM_PROMPT).toContain(c.label);
      expect(SOFTWARE_SPEC_SYSTEM_PROMPT).toContain(c.imperative);
    }
  });

  it('forbids hand-rolled auth in the addendum', () => {
    // The "auth model explicit; never hand-rolled" addendum criterion
    // must be present verbatim in the prompt.
    expect(SOFTWARE_SPEC_SYSTEM_PROMPT).toMatch(/never hand-rolled/i);
    expect(SOFTWARE_SPEC_SYSTEM_PROMPT).toMatch(/per_user_isolation/);
  });
});

describe('SOFTWARE extractor user message', () => {
  const message = buildSoftwareExtractionUserMessage({
    rawPrompt: 'A reading queue: paste URLs, tag them, mark as read.',
  });

  it('contains the FIELD TYPE catalog slice', () => {
    expect(message).toMatch(/FIELD TYPE CATALOG/);
    expect(message).toMatch(/string, text, number, boolean, date, datetime, email, url, enum, reference/);
  });

  it('contains a software WORKED EXEMPLAR with named pages + typed entity fields', () => {
    expect(message).toMatch(/WORKED EXEMPLAR/);
    expect(message).toContain('"queue"');
    expect(message).toContain('"Article"');
    expect(message).toContain('"type": "url"');
    expect(message).toContain('"type": "boolean"');
    expect(message).not.toMatch(/\bTODO\b/);
  });
});

describe('SOFTWARE repair message re-asserts the bar', () => {
  it('echoes the parse error and references the SPEC QUALITY BAR (software)', () => {
    const msg = buildSoftwareRepairUserMessage('entities[0].fields: required');
    expect(msg).toContain('entities[0].fields: required');
    expect(msg).toMatch(/SPEC QUALITY BAR.*software addendum/);
  });
});

// ===========================================================================
// INFRASTRUCTURE
// ===========================================================================
describe('INFRASTRUCTURE extractor system prompt', () => {
  it('embeds every base + INFRA addendum criterion', () => {
    for (const c of SPEC_QUALITY_BAR) {
      expect(INFRA_SPEC_SYSTEM_PROMPT).toContain(c.label);
    }
    for (const c of INFRA_SPEC_ADDENDUM) {
      expect(INFRA_SPEC_SYSTEM_PROMPT).toContain(c.label);
      expect(INFRA_SPEC_SYSTEM_PROMPT).toContain(c.imperative);
    }
  });

  it('requires lifecycle to be declared explicitly (non-implicit)', () => {
    expect(INFRA_SPEC_SYSTEM_PROMPT).toMatch(/lifecycle/);
    expect(INFRA_SPEC_SYSTEM_PROMPT).toMatch(/ephemeral/);
    expect(INFRA_SPEC_SYSTEM_PROMPT).toMatch(/persistent/);
  });
});

describe('INFRASTRUCTURE extractor user message', () => {
  const message = buildInfraExtractionUserMessage({
    rawPrompt: 'A queue, a worker, and Postgres in us-east-1.',
  });

  it('contains the RESOURCE TYPE catalog slice', () => {
    expect(message).toMatch(/RESOURCE TYPE CATALOG/);
    expect(message).toMatch(/postgres_db/);
    expect(message).toMatch(/object_store/);
    expect(message).toMatch(/queue/);
    expect(message).toMatch(/worker/);
    expect(message).toMatch(/cron/);
    expect(message).toMatch(/http_service/);
  });

  it('includes per-type config hints (worker / cron / queue / postgres_db / http_service / object_store)', () => {
    expect(message).toMatch(/cron:.*schedule/);
    expect(message).toMatch(/worker:.*concurrency/);
  });

  it('contains an infrastructure WORKED EXEMPLAR with topology + lifecycle', () => {
    expect(message).toMatch(/WORKED EXEMPLAR/);
    expect(message).toContain('events_queue');
    expect(message).toContain('events_worker');
    expect(message).toContain('"lifecycle": "persistent"');
    expect(message).toContain('"region": "us-east-1"');
    expect(message).not.toMatch(/\bTODO\b/);
  });
});

describe('INFRASTRUCTURE repair message re-asserts the bar', () => {
  it('echoes the parse error and references the SPEC QUALITY BAR (infrastructure)', () => {
    const msg = buildInfraRepairUserMessage('lifecycle: required');
    expect(msg).toContain('lifecycle: required');
    expect(msg).toMatch(/SPEC QUALITY BAR.*infrastructure addendum/);
  });
});

// ===========================================================================
// DRIFT GUARDS — confirm rubric/spec-bar alignment by IMPORTING rubric.ts.
// Module-load IIFE inside rubric.ts throws if any referenced id has
// vanished from the engine. Importing it under a test is the cheapest
// way to assert this guard fires at test-time too.
// ===========================================================================
describe('drift guards', () => {
  it('importing evals/rubric.ts does not throw (all referenced ids resolve)', async () => {
    await expect(import('@/evals/rubric')).resolves.toBeDefined();
  });
});
