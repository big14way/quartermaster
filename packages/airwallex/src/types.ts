// Response shapes for the Airwallex calls Quartermaster makes. Numeric fields are kept as
// the exact text Airwallex sent (see `parseLossless`), so amounts never pass through a float.

export type Num = string;

export interface Balance {
  currency: string;
  available_amount: Num;
  pending_amount: Num;
  reserved_amount: Num;
  total_amount: Num;
}

export interface GlobalAccount {
  id: string;
  currency?: string;
  country_code: string;
  nick_name?: string;
  status: string;
  account_number?: string;
  required_features?: { currency: string; transfer_method: string }[];
}

export interface Deposit {
  id: string;
  amount: Num;
  currency: string;
  global_account_id: string;
  reference?: string;
  status: string;
  created_at: string;
  settled_at?: string;
}

export interface CurrentRate {
  buy_currency: string;
  sell_currency: string;
  currency_pair: string;
  rate: Num;
  created_at?: string;
}

export interface Quote {
  quote_id: string;
  buy_currency: string;
  sell_currency: string;
  buy_amount: Num;
  sell_amount: Num;
  client_rate: Num;
  currency_pair: string;
  validity: string;
  valid_from_at: string;
  valid_to_at: string;
}

export interface Conversion {
  conversion_id: string;
  request_id: string;
  status: string;
  buy_currency: string;
  sell_currency: string;
  buy_amount: Num;
  sell_amount: Num;
  client_rate: Num;
  currency_pair: string;
  quote_id?: string;
  created_at: string;
}

export interface BeneficiaryInput {
  nickname: string;
  transfer_methods: string[];
  beneficiary: {
    entity_type: "COMPANY" | "PERSONAL";
    company_name: string;
    address: { city: string; country_code: string; postcode: string; street_address: string; state?: string };
    bank_details: {
      account_currency: string;
      account_name: string;
      bank_country_code: string;
      iban: string;
      swift_code: string;
      local_clearing_system?: string;
    };
  };
}

export interface Beneficiary extends BeneficiaryInput {
  /** Some responses name it `beneficiary_id`, others `id`; read it through `beneficiaryId()`. */
  beneficiary_id?: string;
  id?: string;
}

export type TransferStatus =
  | "SCHEDULED"
  | "OVERDUE"
  | "PROCESSING"
  | "SENT"
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "SUSPENDED";

export interface Transfer {
  id: string;
  request_id: string;
  status: TransferStatus;
  beneficiary_id: string;
  source_currency: string;
  source_amount?: Num;
  transfer_currency: string;
  transfer_amount: Num;
  transfer_method: string;
  fee_amount?: Num;
  fee_currency?: string;
  reference: string;
  reason: string;
  short_reference_id?: string;
  created_at: string;
  updated_at: string;
  failure_reason?: string;
}

export interface WebhookEvent {
  id: string;
  name: string;
  account_id?: string;
  created_at: string;
  data: { object: Record<string, unknown> };
}

export interface AwxErrorBody {
  code: string;
  message?: string;
  source?: string;
  details?: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  has_more: boolean;
}
