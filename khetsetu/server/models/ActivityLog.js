const mysqlStore = require('../db/mysql-compat');

const activityLogSchema = new mysqlStore.Schema(
  {
    user: {
      type: mysqlStore.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
      index: true
    },
    action: {
      type: String,
      required: [true, 'Action name is required'],
      trim: true
    },
    entityType: {
      type: String,
      trim: true,
      default: ''
    },
    entityId: {
      type: mysqlStore.Schema.Types.ObjectId,
      default: null
    },
    description: {
      type: String,
      trim: true,
      default: ''
    },
    metadata: {
      type: mysqlStore.Schema.Types.Mixed,
      default: () => ({})
    },
    ipAddress: {
      type: String,
      trim: true,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

activityLogSchema.index({ user: 1, createdAt: -1 });

activityLogSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret.__v;
    return ret;
  }
});

const ActivityLog = mysqlStore.model('ActivityLog', activityLogSchema);

module.exports = ActivityLog;
