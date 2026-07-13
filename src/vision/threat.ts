import { BaseSensor, type Anomaly, type Transport } from './base-sensor.js';

export type { Anomaly, Transport } from './base-sensor.js';

export type SecurityState = 'secure' | 'insecure' | 'broken' | 'warning' | 'info';

export interface SecuritySummary {
  state: SecurityState;
  schemeIsCryptographic: boolean;
  explanations: SecurityExplanation[];
  mixedContentRequests: number;
  cspViolations: number;
  certificateErrors: number;
  blockedRequests: BlockedRequest[];
  totalThreats: number;
}

export interface SecurityExplanation {
  securityState: SecurityState;
  title: string;
  summary: string;
  description: string;
  certificate?: string[];
  recommendation?: string;
}

export interface BlockedRequest {
  url: string;
  reason: string;
  timestamp: number;
}

export interface ThreatConfig {
  maxBlockedRequests: number;
}

const DEFAULT_CONFIG: ThreatConfig = {
  maxBlockedRequests: 50,
};

export class ThreatSensor extends BaseSensor<SecuritySummary> {
  private config: ThreatConfig;
  private state: SecurityState = 'info';
  private schemeIsCryptographic: boolean = false;
  private explanations: SecurityExplanation[] = [];
  private certificateErrors: number = 0;
  private blockedRequests: BlockedRequest[] = [];
  private mixedContentCount: number = 0;
  private cspViolationCount: number = 0;
  private pageUrl: string = '';

  constructor(transport: Transport, config?: Partial<ThreatConfig>) {
    super(transport);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  protected doSubscribe(): void {
    this.on('Security.securityStateChanged', (p) => this.onSecurityChanged(p));
    this.on('Security.certificateError', (p) => this.onCertError(p));
    this.on('Network.requestWillBeSent', (p) => this.checkMixedContent(p));
    this.on('Network.loadingFailed', (p) => this.checkBlocked(p));
  }

  private onSecurityChanged(p: any): void {
    this.state = (p.securityState || 'info') as SecurityState;
    this.schemeIsCryptographic = p.schemeIsCryptographic ?? false;
    this.explanations = (p.explanations || []).map((e: any) => ({
      securityState: e.securityState || 'info',
      title: e.title || '',
      summary: e.summary || '',
      description: e.description || '',
      certificate: e.certificate,
      recommendation: e.recommendation,
    }));
  }

  private onCertError(p: any): void {
    void p;
    this.certificateErrors++;
  }

  private checkMixedContent(p: any): void {
    const url: string = p.request?.url || '';
    if (!this.pageUrl && p.type === 'Document') {
      this.pageUrl = url;
    }
    if (this.pageUrl.startsWith('https://') && url.startsWith('http://')) {
      this.mixedContentCount++;
    }
  }

  private checkBlocked(p: any): void {
    const blockedReason = p.blockedReason;
    if (!blockedReason) return;

    const entry: BlockedRequest = {
      url: p.url || '',
      reason: blockedReason,
      timestamp: Date.now(),
    };

    this.blockedRequests.push(entry);
    if (this.blockedRequests.length > this.config.maxBlockedRequests) {
      this.blockedRequests.shift();
    }

    if (blockedReason.toLowerCase().includes('csp')) {
      this.cspViolationCount++;
    }
  }

  async summarize(): Promise<SecuritySummary> {
    const nonCspBlocked = this.blockedRequests.filter(
      (r) => !r.reason.toLowerCase().includes('csp'),
    ).length;
    const totalThreats =
      this.mixedContentCount +
      this.cspViolationCount +
      this.certificateErrors +
      nonCspBlocked;

    return {
      state: this.state,
      schemeIsCryptographic: this.schemeIsCryptographic,
      explanations: this.explanations,
      mixedContentRequests: this.mixedContentCount,
      cspViolations: this.cspViolationCount,
      certificateErrors: this.certificateErrors,
      blockedRequests: [...this.blockedRequests],
      totalThreats,
    };
  }

  async getAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const summary = await this.summarize();
    const now = Date.now();

    if (summary.state === 'insecure' || summary.state === 'broken') {
      anomalies.push({
        domain: 'security',
        severity: 'critical',
        message: `Page security state is ${summary.state}`,
        timestamp: now,
      });
    }

    if (summary.certificateErrors > 0) {
      anomalies.push({
        domain: 'security',
        severity: 'critical',
        message: `${summary.certificateErrors} certificate error(s)`,
        timestamp: now,
      });
    }

    if (summary.mixedContentRequests > 0) {
      anomalies.push({
        domain: 'security',
        severity: 'warning',
        message: `${summary.mixedContentRequests} mixed content request(s) detected`,
        timestamp: now,
      });
    }

    if (summary.cspViolations > 0) {
      anomalies.push({
        domain: 'security',
        severity: 'warning',
        message: `${summary.cspViolations} CSP violation(s)`,
        timestamp: now,
      });
    }

    return anomalies;
  }

  clear(): void {
    this.state = 'info';
    this.explanations = [];
    this.certificateErrors = 0;
    this.blockedRequests = [];
    this.mixedContentCount = 0;
    this.cspViolationCount = 0;
    this.pageUrl = '';
  }
}
