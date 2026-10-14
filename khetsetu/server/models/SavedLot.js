const mysqlStore = require('../db/mysql-compat');

const savedLotSchema = new mysqlStore.Schema(
  {
    buyer: {
      type: mysqlStore.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    lot: {
      type: mysqlStore.Schema.Types.ObjectId,
      ref: 'ProduceLot',
      required: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

// Compound unique index to prevent duplicate saves by the same buyer
savedLotSchema.index({ buyer: 1, lot: 1 }, { unique: true });

savedLotSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

const SavedLot = mysqlStore.model('SavedLot', savedLotSchema);

module.exports = SavedLot;
