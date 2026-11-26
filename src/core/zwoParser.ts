export type WorkoutStepKind =
  | 'warmup'
  | 'cooldown'
  | 'ramp'
  | 'steady'
  | 'interval-on'
  | 'interval-off'
  | 'freeride';

export interface FlattenedStep {
  id: string;
  index: number;
  kind: WorkoutStepKind;
  label: string;
  duration: number; // seconds
  startTime: number; // seconds from workout start
  endTime: number; // seconds from workout start
  powerLow: number; // fraction of FTP (e.g. 0.68)
  powerHigh: number; // fraction of FTP (equals powerLow for steady steps)
  cadenceTarget?: number;
  groupId?: string;
  repeatIndex?: number; // 1-based current repeat inside group
  repeatTotal?: number;
  stepInRepeat?: number; // 0 for ON, 1 for OFF
}

export interface SingleStepNode {
  type: 'step';
  id: string;
  stepIndex: number;
  kind: WorkoutStepKind;
  label: string;
  duration: number;
  powerLow: number;
  powerHigh: number;
  cadenceTarget?: number;
}

export interface RepeatGroupChildTemplate {
  kind: 'interval-on' | 'interval-off';
  label: string;
  duration: number;
  powerLow: number;
  powerHigh: number;
  cadenceTarget?: number;
}

export interface RepeatGroupNode {
  type: 'group';
  id: string;
  label: string;
  repeat: number;
  firstStepIndex: number;
  lastStepIndex: number;
  totalDuration: number;
  childrenTemplate: RepeatGroupChildTemplate[];
}

export type WorkoutTreeNode = SingleStepNode | RepeatGroupNode;

export interface ParsedWorkout {
  id: string;
  name: string;
  author: string;
  description: string;
  sportType: string;
  tags: string[];
  totalDuration: number;
  estimatedTss: number;
  intensityFactor: number;
  tree: WorkoutTreeNode[];
  timeline: FlattenedStep[];
  rawXml: string;
}

interface XmlElementNode {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlElementNode[];
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrString)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/**
 * Lightweight, deterministic XML parser that works identically in browsers and Node tests.
 */
function parseXmlTree(xml: string): XmlElementNode | null {
  const cleaned = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  const tokenRegex = /<\/?([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  const stack: XmlElementNode[] = [];
  let root: XmlElementNode | null = null;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(cleaned)) !== null) {
    const [full, tagName, attrPart, selfClose, textContent] = match;
    if (textContent !== undefined) {
      if (stack.length > 0) {
        stack[stack.length - 1].text += decodeXmlEntities(textContent);
      }
      continue;
    }

    if (full.startsWith('</')) {
      if (stack.length > 0 && stack[stack.length - 1].tag === tagName) {
        stack.pop();
      }
      continue;
    }

    const node: XmlElementNode = {
      tag: tagName,
      attrs: parseAttributes(attrPart || ''),
      text: '',
      children: [],
    };

    if (stack.length === 0) {
      root = node;
    } else {
      stack[stack.length - 1].children.push(node);
    }

    if (selfClose !== '/') {
      stack.push(node);
    }
  }

  return root;
}

function getChildText(parent: XmlElementNode, tagLower: string): string {
  const found = parent.children.find((c) => c.tag.toLowerCase() === tagLower);
  return found ? found.text.trim() : '';
}

function getNumAttr(attrs: Record<string, string>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const foundKey = Object.keys(attrs).find((k) => k.toLowerCase() === key.toLowerCase());
    if (foundKey !== undefined) {
      const val = Number(attrs[foundKey]);
      if (Number.isFinite(val)) return val;
    }
  }
  return fallback;
}

function getStrAttr(attrs: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const foundKey = Object.keys(attrs).find((k) => k.toLowerCase() === key.toLowerCase());
    if (foundKey !== undefined && attrs[foundKey].trim() !== '') {
      return attrs[foundKey].trim();
    }
  }
  return undefined;
}

/**
 * Parse a Zwift .zwo XML string into both a grouped nested tree (for UI display)
 * and a flattened timeline (for the workout engine and history graph).
 */
export function parseZwoWorkout(xml: string, fallbackId = 'workout-1'): ParsedWorkout {
  const root = parseXmlTree(xml);
  if (!root) {
    throw new Error('Invalid workout XML: could not find root element.');
  }

  const name = getChildText(root, 'name') || 'Untitled Workout';
  const author = getChildText(root, 'author') || 'Unknown Author';
  const description = getChildText(root, 'description') || '';
  const sportType = getChildText(root, 'sporttype') || 'bike';

  const tagsNode = root.children.find((c) => c.tag.toLowerCase() === 'tags');
  const tags: string[] = [];
  if (tagsNode) {
    for (const child of tagsNode.children) {
      if (child.tag.toLowerCase() === 'tag') {
        const tagName = getStrAttr(child.attrs, ['name']);
        if (tagName && !tags.includes(tagName)) {
          tags.push(tagName);
        }
      }
    }
  }

  const workoutNode = root.children.find((c) => c.tag.toLowerCase() === 'workout');
  if (!workoutNode) {
    throw new Error('Invalid workout XML: missing <workout> block.');
  }

  const tree: WorkoutTreeNode[] = [];
  const timeline: FlattenedStep[] = [];
  let cursorTime = 0;
  let steadyCounter = 0;
  let groupCounter = 0;

  for (const elem of workoutNode.children) {
    const tag = elem.tag.toLowerCase();
    const customLabel = getStrAttr(elem.attrs, ['label', 'name']);

    if (tag === 'warmup' || tag === 'cooldown' || tag === 'ramp') {
      const duration = Math.max(1, Math.round(getNumAttr(elem.attrs, ['Duration'], 300)));
      const defaultLow = tag === 'cooldown' ? 0.65 : 0.45;
      const defaultHigh = tag === 'cooldown' ? 0.4 : 0.75;
      const powerLow = getNumAttr(elem.attrs, ['PowerLow', 'Power'], defaultLow);
      const powerHigh = getNumAttr(elem.attrs, ['PowerHigh', 'Power'], defaultHigh);
      const cadenceTarget = getNumAttr(elem.attrs, ['Cadence'], 0) || undefined;

      const kind: WorkoutStepKind =
        tag === 'warmup' ? 'warmup' : tag === 'cooldown' ? 'cooldown' : 'ramp';
      const label =
        customLabel || (tag === 'warmup' ? 'Warmup' : tag === 'cooldown' ? 'Cooldown' : 'Ramp');

      const stepIndex = timeline.length;
      const id = `step-${stepIndex}`;

      timeline.push({
        id,
        index: stepIndex,
        kind,
        label,
        duration,
        startTime: cursorTime,
        endTime: cursorTime + duration,
        powerLow,
        powerHigh,
        cadenceTarget,
      });

      tree.push({
        type: 'step',
        id,
        stepIndex,
        kind,
        label,
        duration,
        powerLow,
        powerHigh,
        cadenceTarget,
      });

      cursorTime += duration;
    } else if (tag === 'steadystate' || tag === 'freeride') {
      const duration = Math.max(1, Math.round(getNumAttr(elem.attrs, ['Duration'], 60)));
      const power =
        tag === 'freeride'
          ? getNumAttr(elem.attrs, ['Power'], 0.6)
          : getNumAttr(elem.attrs, ['Power', 'PowerLow'], 0.75);
      const cadenceTarget = getNumAttr(elem.attrs, ['Cadence'], 0) || undefined;
      steadyCounter += 1;
      const kind: WorkoutStepKind = tag === 'freeride' ? 'freeride' : 'steady';
      const label =
        customLabel ||
        (tag === 'freeride' ? 'Free Ride' : power <= 0.56 ? `Recovery` : `Step ${steadyCounter}`);

      const stepIndex = timeline.length;
      const id = `step-${stepIndex}`;

      timeline.push({
        id,
        index: stepIndex,
        kind,
        label,
        duration,
        startTime: cursorTime,
        endTime: cursorTime + duration,
        powerLow: power,
        powerHigh: power,
        cadenceTarget,
      });

      tree.push({
        type: 'step',
        id,
        stepIndex,
        kind,
        label,
        duration,
        powerLow: power,
        powerHigh: power,
        cadenceTarget,
      });

      cursorTime += duration;
    } else if (tag === 'intervalst') {
      const repeat = Math.max(1, Math.round(getNumAttr(elem.attrs, ['Repeat'], 1)));
      const onDuration = Math.max(1, Math.round(getNumAttr(elem.attrs, ['OnDuration'], 30)));
      const offDuration = Math.max(1, Math.round(getNumAttr(elem.attrs, ['OffDuration'], 30)));
      const onPower = getNumAttr(elem.attrs, ['OnPower'], 1.15);
      const offPower = getNumAttr(elem.attrs, ['OffPower'], 0.5);
      const onCadence = getNumAttr(elem.attrs, ['Cadence'], 0) || undefined;
      const offCadence = getNumAttr(elem.attrs, ['CadenceResting'], 0) || undefined;

      groupCounter += 1;
      const groupId = `group-${groupCounter}`;
      const groupLabel = customLabel || `Interval Set ${groupCounter}`;
      const firstStepIndex = timeline.length;

      for (let r = 1; r <= repeat; r++) {
        // ON interval
        const onIdx = timeline.length;
        timeline.push({
          id: `${groupId}-r${r}-on`,
          index: onIdx,
          kind: 'interval-on',
          label: `${groupLabel} · Work (${r}/${repeat})`,
          duration: onDuration,
          startTime: cursorTime,
          endTime: cursorTime + onDuration,
          powerLow: onPower,
          powerHigh: onPower,
          cadenceTarget: onCadence,
          groupId,
          repeatIndex: r,
          repeatTotal: repeat,
          stepInRepeat: 0,
        });
        cursorTime += onDuration;

        // OFF interval
        const offIdx = timeline.length;
        timeline.push({
          id: `${groupId}-r${r}-off`,
          index: offIdx,
          kind: 'interval-off',
          label: `${groupLabel} · Rest (${r}/${repeat})`,
          duration: offDuration,
          startTime: cursorTime,
          endTime: cursorTime + offDuration,
          powerLow: offPower,
          powerHigh: offPower,
          cadenceTarget: offCadence,
          groupId,
          repeatIndex: r,
          repeatTotal: repeat,
          stepInRepeat: 1,
        });
        cursorTime += offDuration;
      }

      const lastStepIndex = timeline.length - 1;
      tree.push({
        type: 'group',
        id: groupId,
        label: groupLabel,
        repeat,
        firstStepIndex,
        lastStepIndex,
        totalDuration: repeat * (onDuration + offDuration),
        childrenTemplate: [
          {
            kind: 'interval-on',
            label: 'Work',
            duration: onDuration,
            powerLow: onPower,
            powerHigh: onPower,
            cadenceTarget: onCadence,
          },
          {
            kind: 'interval-off',
            label: 'Rest',
            duration: offDuration,
            powerLow: offPower,
            powerHigh: offPower,
            cadenceTarget: offCadence,
          },
        ],
      });
    }
  }

  const totalDuration = cursorTime;

  // Estimate TSS using fourth-power normalized intensity factor approximation
  let weightedFourthPowerSum = 0;
  for (const step of timeline) {
    const avgPower = (step.powerLow + step.powerHigh) / 2;
    weightedFourthPowerSum += Math.pow(avgPower, 4) * step.duration;
  }
  const intensityFactor =
    totalDuration > 0 ? Math.pow(weightedFourthPowerSum / totalDuration, 0.25) : 0;
  const estimatedTss =
    totalDuration > 0 ? Math.round((totalDuration / 3600) * intensityFactor * intensityFactor * 100) : 0;

  return {
    id: fallbackId,
    name,
    author,
    description,
    sportType,
    tags,
    totalDuration,
    estimatedTss,
    intensityFactor: Math.round(intensityFactor * 100) / 100,
    tree,
    timeline,
    rawXml: xml,
  };
}
