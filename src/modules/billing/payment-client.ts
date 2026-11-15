/** Shared payment-provider interface for Duitku and SumoPod. */

export interface InvoiceRequest {
  merchantOrderId: string;
  amountIdr: number;
  productDetails: string;
  email: string;
  returnUrl: string;
  /** Not every gateway supports this (SumoPod does not); ignored when the provider ignores it. */
  expiryMinutes?: number;
}

export interface InvoiceResponse {
  reference: string;
  paymentUrl: string;
}

export interface PaymentClient {
  createInvoice(input: InvoiceRequest): Promise<InvoiceResponse>;
}