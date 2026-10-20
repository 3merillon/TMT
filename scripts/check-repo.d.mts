export interface ReleaseFile {
  path: string;
  size: number;
}

export interface RepositoryBudget {
  publicMaxBytes: number;
  docsImages: {
    directory: string;
    maxTotalBytes: number;
    maxFileBytes: number;
  };
  assetsMaxBytes: number;
  sourceGlbMaxBytes: number;
  videoExtensions?: string[];
  videoAllowlist?: string[];
  forbiddenDirectories?: string[];
  docFiles?: string[];
  docsScope?: string;
}

export interface RepositoryIssue {
  code: string;
  message: string;
  file?: string;
}

export interface RepositoryTotals {
  files: number;
  publicBytes: number;
  assetsBytes: number;
  sourceGlbBytes: number;
  docsImageBytes: number;
}

export interface RepositoryCheckResult {
  issues: RepositoryIssue[];
  totals: RepositoryTotals;
}

export function collectReleaseFiles(rootDir?: string): ReleaseFile[];

export function auditReleaseFiles(
  files: readonly ReleaseFile[],
  budget: RepositoryBudget,
): RepositoryCheckResult;

export function runRepositoryCheck(rootDir?: string): RepositoryCheckResult;
