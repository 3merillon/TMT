import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { CAMPAIGN } from '../src/game/campaign/catalog';
import { SPEAKERS } from '../src/game/campaign/mission';
import { speechText, voiceKey } from '../src/audio/campaign-voice-key';

/** Extract the actual authored dialogue, including conditional lines and both endings.
 * Shared beat helpers are expanded at their call sites; changing prose invalidates its key. */
export function campaignCorpus() {
  const lines = new Map<string, { id: string; speaker: string; text: string }>();
  const add = (speaker: string, text: string) => {
    text = speechText(text);
    const id = voiceKey(speaker, text), previous = lines.get(id);
    if (previous && (previous.text !== text || previous.speaker !== speaker)) throw new Error(`Voice key collision: ${id}`);
    lines.set(id, { id, speaker, text });
  };
  const resolve = (n: ts.Expression | undefined): string | undefined => n && ts.isStringLiteralLike(n) ? n.text
    : n && ts.isIdentifier(n) ? (SPEAKERS as Record<string, string>)[n.text] : undefined;
  for (const file of ['prologue', 'acts', 'beats', 'bosses', 'launch-defence', 'whiteout', 'mission']) {
    const source = ts.createSourceFile(file, readFileSync(`src/game/campaign/${file}.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const e = node.expression, args = node.arguments;
        if (ts.isPropertyAccessExpression(e) && e.name.text === 'say') {
          const speaker = resolve(args[0]), text = args[1];
          if (speaker && text) {
            if (ts.isConditionalExpression(text)) {
              for (const branch of [text.whenTrue, text.whenFalse]) { const line = resolve(branch); if (line) add(speaker, line); }
            } else { const line = resolve(text); if (line) add(speaker, line); }
          }
        }
        if (ts.isIdentifier(e)) {
          const name = e.text;
          const speaker = name === 'travel' ? resolve(args[3]) ?? 'Sgt. Sprocket' : name === 'battle' ? 'Mags' : name === 'radio' ? resolve(args[1]) : undefined;
          const text = resolve(args[name === 'battle' ? 3 : 2]);
          if (speaker && text) add(speaker, text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const mission of CAMPAIGN) {
    add('Narrator', mission.briefing);
    if (mission.intel) add('Sgt. Sprocket', mission.intel);
    if (mission.optional) add('Sgt. Sprocket', `Recovered ${mission.optional.reward}. Good detour, Rook.`);
  }
  return [...lines.values()].sort((a, b) => a.speaker.localeCompare(b.speaker) || a.id.localeCompare(b.id));
}
