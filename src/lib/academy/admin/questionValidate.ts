// Shared validation for the Admin / Questions author APIs. Validates
// the shape the editor island posts: prompt, options, correct_option_id,
// question_key, section_anchor, sort_order. The approval check is in
// the approve route; here we only enforce the fields' shape invariants
// so the create + save + save-as-draft + approve routes all share one
// definition.

export interface OptionIn {
  id: string;
  text: string;
  explanation?: string;
}

export interface FieldsIn {
  prompt: string;
  options: OptionIn[];
  correct_option_id: string;
  question_key?: string;
  section_anchor?: string | null;
  sort_order?: number | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  clean?: {
    prompt: string;
    options: OptionIn[];
    correct_option_id: string;
    question_key?: string;
    section_anchor: string | null;
    sort_order: number;
  };
}

// Letters, digits, dot, dash, underscore - stable slug alphabet.
const QKEY_RE = /^[A-Za-z0-9._-]{2,80}$/;
const OPTID_RE = /^[A-Za-z0-9._-]{1,32}$/;

export function validateQuestionFields(
  body: unknown,
  opts: { requireQuestionKey: boolean },
): ValidationResult {
  const errors: string[] = [];
  const b = (body || {}) as Record<string, unknown>;

  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt) errors.push("prompt is required.");
  if (prompt.length > 2000) errors.push("prompt is too long (max 2000 chars).");

  const options: OptionIn[] = [];
  if (!Array.isArray(b.options)) {
    errors.push("options must be an array.");
  } else {
    const seenIds = new Set<string>();
    for (let i = 0; i < b.options.length; i++) {
      const raw = b.options[i] as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") {
        errors.push(`options[${i}] must be an object.`);
        continue;
      }
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      const expl =
        typeof raw.explanation === "string" ? raw.explanation : undefined;
      if (!id || !OPTID_RE.test(id)) {
        errors.push(`options[${i}].id must be a short slug (letters, digits, . _ -).`);
      } else if (seenIds.has(id)) {
        errors.push(`options[${i}].id "${id}" is duplicated.`);
      } else {
        seenIds.add(id);
      }
      if (!text) errors.push(`options[${i}].text is required.`);
      options.push({ id, text, explanation: expl });
    }
    if (options.length < 2) errors.push("A question needs at least two options.");
    if (options.length > 4) errors.push("A question has no more than four options.");
  }

  const correct_option_id =
    typeof b.correct_option_id === "string" ? b.correct_option_id.trim() : "";
  if (!correct_option_id) {
    errors.push("correct_option_id is required.");
  } else if (!options.some((o) => o.id === correct_option_id)) {
    errors.push("correct_option_id must match one of the options.");
  }

  let question_key: string | undefined;
  if (opts.requireQuestionKey) {
    question_key = typeof b.question_key === "string" ? b.question_key.trim() : "";
    if (!question_key || !QKEY_RE.test(question_key)) {
      errors.push(
        "question_key is required: a short stable slug (letters, digits, . _ -, 2 to 80 chars).",
      );
    }
  }

  let section_anchor: string | null = null;
  if (b.section_anchor != null) {
    if (typeof b.section_anchor !== "string") {
      errors.push("section_anchor must be a string or null.");
    } else {
      const trimmed = b.section_anchor.trim();
      section_anchor = trimmed ? trimmed : null;
    }
  }

  let sort_order = 0;
  if (b.sort_order != null) {
    const n = Number(b.sort_order);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      errors.push("sort_order must be a non-negative integer.");
    } else {
      sort_order = Math.floor(n);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    clean: {
      prompt,
      options,
      correct_option_id,
      question_key,
      section_anchor,
      sort_order,
    },
  };
}

export function parseQuestionId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}
