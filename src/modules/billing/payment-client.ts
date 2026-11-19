/** Payment-provider interface (implemented by the SumoPod client and the test fake). */

export interface InvoiceRequest {
  merchantOrderId: string;
  amountIdr: number;
  productDetails: string;
  email: string;
  returnUrl: string;
  /** SumoPod does not support this; its client ignores it. */
  expiryMinutes?: number;
}

export interface InvoiceResponse {
  reference: string;
  paymentUrl: string;
}

export interface PaymentClient {
  createInvoice(input: InvoiceRequest): Promise<InvoiceResponse>;
}