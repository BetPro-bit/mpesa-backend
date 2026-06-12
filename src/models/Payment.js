const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema(
  {
    // ── STK Push Identifiers ──────────────────────────────────────────────
    merchantRequestId: {
      type: String,
      index: true,
    },
    checkoutRequestId: {
      type: String,
      unique: true,
      sparse: true, // allows null until callback arrives
      index: true,
    },

    // ── Request Details ───────────────────────────────────────────────────
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      match: [/^2547\d{8}$/, 'Phone must be in format 2547XXXXXXXX'],
    },
    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      min: [1, 'Amount must be at least 1'],
    },
    accountReference: {
      type: String,
      required: [true, 'Account reference is required'],
      maxlength: [12, 'Account reference cannot exceed 12 characters'],
    },
    transactionDesc: {
      type: String,
      maxlength: [13, 'Transaction description cannot exceed 13 characters'],
    },

    // ── Callback / Result Details ─────────────────────────────────────────
    resultCode: {
      type: Number,
      default: null,
    },
    resultDesc: {
      type: String,
      default: null,
    },
    receiptNumber: {
      type: String,       // MpesaReceiptNumber from Safaricom
      default: null,
    },
    transactionDate: {
      type: String,       // Raw Daraja format: YYYYMMDDHHMMSS
      default: null,
    },

    // ── Status ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT'],
      default: 'PENDING',
    },

    // ── Raw payloads (useful for debugging) ──────────────────────────────
    stkPushResponse: {
      type: mongoose.Schema.Types.Mixed,
      select: false,   // excluded from default queries
    },
    callbackPayload: {
      type: mongoose.Schema.Types.Mixed,
      select: false,
    },
  },
  {
    timestamps: true,   // createdAt + updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
PaymentSchema.index({ status: 1, createdAt: -1 });
PaymentSchema.index({ phone: 1, createdAt: -1 });

// ── Virtual: human-readable date ─────────────────────────────────────────────
PaymentSchema.virtual('formattedDate').get(function () {
  if (!this.transactionDate) return null;
  const d = this.transactionDate;
  // YYYYMMDDHHMMSS → ISO
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
});

// ── Static: mark timed-out pending payments ──────────────────────────────────
PaymentSchema.statics.expirePendingPayments = async function (minutesOld = 10) {
  const cutoff = new Date(Date.now() - minutesOld * 60 * 1000);
  return this.updateMany(
    { status: 'PENDING', createdAt: { $lt: cutoff } },
    { status: 'TIMEOUT' }
  );
};

module.exports = mongoose.model('Payment', PaymentSchema);
