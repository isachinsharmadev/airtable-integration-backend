import mongoose, { Schema, Document } from "mongoose";

/**
 * Revision History Model
 * Stores individual change records for Assignee and Status fields
 */

export interface IRevisionHistoryItem {
  uuid: string; // Unique identifier for this activity
  issueId: string; // The record/ticket ID (e.g., recXXXXXXXXXXXXXX)
  columnType: "assignee" | "status"; // Type of change
  oldValue: string | null; // Previous value
  newValue: string | null; // New value
  createdDate: Date; // When the change occurred
  authoredBy: string; // User who made the change (name or email)
}

export interface IRevisionHistory extends Document {
  pageId: string; // The record/ticket ID
  baseId: string; // Airtable base ID
  tableId: string; // Airtable table ID
  revisions: IRevisionHistoryItem[]; // Array of revision items
  updatedAt: Date;
  createdAt: Date;
}

const RevisionHistoryItemSchema = new Schema(
  {
    uuid: { type: String, required: true },
    issueId: { type: String, required: true },
    columnType: {
      type: String,
      required: true,
      enum: ["assignee", "status"],
    },
    oldValue: { type: String, default: null },
    newValue: { type: String, default: null },
    createdDate: { type: Date, required: true },
    authoredBy: { type: String, required: true },
  },
  { _id: false }
);

const RevisionHistorySchema = new Schema(
  {
    pageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    baseId: {
      type: String,
      required: true,
      index: true,
    },
    tableId: {
      type: String,
      required: true,
      index: true,
    },
    revisions: [RevisionHistoryItemSchema],
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries
RevisionHistorySchema.index({ baseId: 1, tableId: 1 });
RevisionHistorySchema.index({ pageId: 1 }, { unique: true });

export default mongoose.model<IRevisionHistory>(
  "RevisionHistory",
  RevisionHistorySchema
);
