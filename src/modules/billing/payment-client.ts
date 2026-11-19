/** Payment-provider interface (implemented by the SumoPod client and the test fake). */

export interface InvoiceRequest {
  merchantOrderId: string;
  amountIdr: number;
  productDetails: string;
  email: string;
  returnUrl: string;
  /** Sent to SumoPod as `expires_in_hours`, rounded up to whole hours (1 to 24). */
  expiryMinutes?: number;
}

export interface InvoiceResponse {
  reference: string;
  paymentUrl: string;
}

export interface PaymentClient {
  createInvoice(input: InvoiceRequest): Promise<InvoiceResponse>;
}