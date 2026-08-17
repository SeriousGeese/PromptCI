import type { RepoContext } from '../repo-context.js';
import type { PromptCiIssue } from '../types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function detectUnity(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { repoRoot, files } = context;

  const hasAssets = fs.existsSync(path.join(repoRoot, 'Assets'));
  const hasProjectVersion = fs.existsSync(path.join(repoRoot, 'ProjectSettings', 'ProjectVersion.txt'));
  
  const combinedContent = files.map(f => f.content).join('\n');
  const hasUnityMentions = /\bunity\b.*\b(lts|editor|hub|engine)\b|\bmonobehaviour\b|\bunityengine\b|\bgameobject\b|\bprefab\b|\bscriptableobject\b/i.test(combinedContent);

  if (!(hasAssets && hasProjectVersion) && !hasUnityMentions) {
    return [];
  }

  const allFilePaths = files.map(f => f.path);

  // 1. MonoBehaviour lifecycle guidance
  const hasMonoBehaviourGuidance =
    /monobehaviour\s+(?:lifecycle|guidance|rules?)|\blifecycle\s+(?:method|methods|guidance|rules?)|instantiate\b.*monobehaviour|avoid\b.*update|new\s+monobehaviour|awake\(\)|start\(\)|update\(\)/i.test(combinedContent);
  if (!hasMonoBehaviourGuidance) {
    issues.push({
      id: 'unity-missing-monobehaviour-guidance',
      severity: 'warning',
      category: 'structure',
      title: 'Missing Unity MonoBehaviour Lifecycle Guidance',
      summary: 'Unity project detected, but instructions lack guidelines on MonoBehaviour lifecycle (e.g. not calling "new" on MonoBehaviours, avoiding empty Update methods).',
      filePaths: allFilePaths,
      locations: [],
      evidence: ['Unity detected, but no MonoBehaviour lifecycle rules found in instructions.'],
      recommendation: 'Add guidance warning never to use "new" to instantiate MonoBehaviours, and advising on efficient Update() / Awake() / Start() usage.',
      fixRecipe: 'Do not instantiate MonoBehaviours using the "new" keyword; always use GameObject.AddComponent or Object.Instantiate. Avoid leaving empty Awake, Start, or Update methods in scripts as they still incur Unity lifecycle overhead.',
      confidence: 0.8,
    });
  }

  // 2. Serialization & Prefab Safety guidance
  // FW2: bare 'prefab' also satisfies hasUnityMentions above — a file whose
  // ONLY Unity signal is a passing mention of "prefab" (e.g. "we use prefabs
  // for reusable components") would enable the pack AND simultaneously
  // satisfy this guidance check with the exact same word, so the
  // serialization/prefab-safety warning could never fire for that file. The
  // bare word is removed here; "prefab" only counts as real GUIDANCE (not
  // just a mention) when paired with a guidance-indicating term.
  const hasSerializationGuidance = /\[serializefield\]|serializefield\b|prefab\s+(?:safety|workflow|guidance|rules?)|meta\s+file/i.test(combinedContent);
  if (!hasSerializationGuidance) {
    issues.push({
      id: 'unity-missing-serialization-guidance',
      severity: 'warning',
      category: 'structure',
      title: 'Missing Unity Serialization and Prefab Safety Guidance',
      summary: 'Unity project detected, but instructions lack safety rules for Prefabs and [SerializeField] parameters.',
      filePaths: allFilePaths,
      locations: [],
      evidence: ['Unity detected, but no SerializeField or prefab rules found in instructions.'],
      recommendation: 'Add rules for using [SerializeField] for private variables to expose them in the inspector, and avoiding editing .meta files manually.',
      fixRecipe: 'Use [SerializeField] to expose private fields in the Unity Inspector instead of making them public. Never manually edit or delete .meta files; let the Unity Editor manage them to prevent serialization breakages.',
      confidence: 0.8,
    });
  }

  // 3. Play Mode & Test Runner verification guidance
  const hasTestRunnerGuidance = /play\s+mode|test\s+runner|unity\s+test/i.test(combinedContent);
  if (!hasTestRunnerGuidance) {
    issues.push({
      id: 'unity-missing-test-guidance',
      severity: 'info',
      category: 'structure',
      title: 'Missing Unity Play Mode and Test Runner Guidance',
      summary: 'Unity project detected, but instructions do not guide agents to test changes in Play Mode or Unity Test Runner.',
      filePaths: allFilePaths,
      locations: [],
      evidence: ['Unity detected, but no Play Mode/Test Runner verification found in instructions.'],
      recommendation: 'Add instructions telling agents to run tests using Unity Test Runner or test changes in Play Mode.',
      fixRecipe: 'Verify gameplay and UI changes by testing in the Unity Editor Play Mode or running Unity Test Runner (Window > General > Test Runner).',
      confidence: 0.75,
    });
  }

  return issues;
}
