import type { SignVendor, RiskFlag } from '../events.js';

export type { SignVendor, RiskFlag };

export interface SignerProfile {
  fullName: string;
  initials: string;
  title: string | null;
  address: string | null;
  phone: string | null;
  defaultDateFormat: string;
  createdAt: number;
  updatedAt: number;
}

export type SignCeremonyState =
  | 'detected'
  | 'summarized'
  | 'approval_requested'
  | 'approved'
  | 'signing'
  | 'signed'
  | 'failed'
  | 'cancelled';

export interface SignCeremony {
  id: string;
  emailId: string;
  vendor: SignVendor;
  signUrl: string;
  docTitle: string | null;
  state: SignCeremonyState;
  summaryText: string | null;
  riskFlags: RiskFlag[];
  signedPdfPath: string | null;
  failureReason: string | null;
  failureScreenshotPath: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type FieldTag =
  | 'signature'
  | 'initial'
  | 'date_signed'
  | 'text'
  | 'check';

export interface ProfileFieldMatch {
  profileKey: 'fullName' | 'initials' | 'title' | 'address' | 'phone';
  value: string;
}
