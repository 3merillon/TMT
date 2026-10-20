/** Composition root (APPEND-ONLY, plan §7.3): each stream adds one side-effect import on its own line,
 * tagged `// <STREAM-ID>`, in its section. Conflicts resolve by union. Imported once by main.ts. */

// audio
import '../../audio'; // W1-AUDIO

// juice

// extensions

// presenters

export {};
