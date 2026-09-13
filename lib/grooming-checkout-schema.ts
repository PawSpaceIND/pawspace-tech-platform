import { z } from "zod";

const indianPhone = z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number");

export const groomingCheckoutSchema = z.object({
  customerName: z.string().trim().min(2, "Customer name is required"),
  customerPhone: indianPhone,
  alternativePhone: indianPhone,
  addressLine1: z.string().trim().min(5, "Address Line 1 is required"),
  addressLine2: z.string().trim().max(160, "Address Line 2 is too long").optional().default(""),
  specialInstructions: z.string().trim().max(500, "Special instructions are too long").optional().default(""),
});

export type GroomingCheckoutFields = z.infer<typeof groomingCheckoutSchema>;

export function validGroomingCheckout(fields: GroomingCheckoutFields) {
  return groomingCheckoutSchema.safeParse(fields).success;
}
