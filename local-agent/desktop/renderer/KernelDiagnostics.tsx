import type { ExperimentalTrialView } from './types';

export default function KernelDiagnostics({ trial }: { trial: Pick<ExperimentalTrialView, 'streaming' | 'backendValidation' | 'parityReportDigest'> }) {
  const streaming = trial.streaming;
  const count = (value: number | null | undefined) => Number.isSafeInteger(value) && value! >= 0 ? String(value) : 'Unreported';
  const metrics = [
    ['CPU kernel', streaming?.cpuKernel && streaming.cpuKernel !== 'unknown' ? streaming.cpuKernel : 'Unreported'],
    ['Extra CPU buffer types', streaming?.useExtraBufts === false ? 'Disabled' : streaming?.useExtraBufts === true ? 'Enabled' : 'Unreported'],
    ['Repacked tensors', count(streaming?.cpuRepackTensorCount)],
    ['Decode threads', count(streaming?.decodeThreads)], ['Batch threads', count(streaming?.batchThreads)],
    ['Backend validation', trial.backendValidation ?? 'Unreported'],
  ];
  return <details className="model-validation review-block" aria-label="Compute kernel diagnostics">
    <summary>Compute kernel &amp; parity</summary>
    <dl className="trial-metrics">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p>Parity report digest: <code>{trial.parityReportDigest?.slice(0, 64) || 'Unreported'}</code></p>
    <p>Kernel measurements describe the reported worker configuration. Task quality requires its own checks.</p>
  </details>;
}
