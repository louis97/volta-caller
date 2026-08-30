import { env } from "../config/env";

/**
 * Turn-taking settings that can change between two calls.
 *
 * The right values are a property of the room, not of the code: a handset held
 * to the ear and a phone on speaker in a loud room need very different
 * sensitivity, and during a rehearsal that has to be adjustable without a
 * redeploy. Held in memory on purpose — it is a dial for the session, not
 * configuration worth persisting.
 */
export type TurnTuning = {
  /** Higher needs louder, clearer speech to count as an interruption. */
  threshold: number;
  /** How long a pause must last before the caller is considered finished. */
  silenceMs: number;
  prefixMs: number;
  noiseReduction: "near_field" | "far_field" | "none";
  turnDetection: "server_vad" | "semantic_vad";
  eagerness: "low" | "medium" | "high";
};

/**
 * A phone on a table with everyone listening: the microphone picks up the
 * agent's own voice and the room, so interruption has to be much harder to
 * trigger than for a handset at someone's ear.
 */
export const SPEAKERPHONE_PRESET: TurnTuning = {
  threshold: 0.9,
  silenceMs: 900,
  prefixMs: 300,
  noiseReduction: "far_field",
  turnDetection: "server_vad",
  eagerness: "low"
};

export const HANDSET_PRESET: TurnTuning = {
  threshold: 0.6,
  silenceMs: 500,
  prefixMs: 300,
  noiseReduction: "near_field",
  turnDetection: "server_vad",
  eagerness: "low"
};

function fromEnv(): TurnTuning {
  return {
    threshold: env.REALTIME_VAD_THRESHOLD,
    silenceMs: env.REALTIME_VAD_SILENCE_MS,
    prefixMs: env.REALTIME_VAD_PREFIX_MS,
    noiseReduction: env.REALTIME_NOISE_REDUCTION,
    turnDetection: env.REALTIME_TURN_DETECTION,
    eagerness: env.REALTIME_VAD_EAGERNESS
  };
}

let current: TurnTuning = fromEnv();

export function getTurnTuning(): TurnTuning {
  return { ...current };
}

/** Applies to calls placed from now on; a call in progress keeps its session. */
export function setTurnTuning(patch: Partial<TurnTuning>): TurnTuning {
  current = { ...current, ...patch };
  return getTurnTuning();
}

export function resetTurnTuning(): TurnTuning {
  current = fromEnv();
  return getTurnTuning();
}
