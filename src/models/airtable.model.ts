import mongoose, { Schema, Document } from "mongoose";

// OAuth Token Schema
export interface IOAuthToken extends Document {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  createdAt: Date;
  updatedAt: Date;
}

const OAuthTokenSchema = new Schema<IOAuthToken>({
  accessToken: { type: String, required: true },
  refreshToken: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  scope: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Base (Project) Schema
export interface IBase extends Document {
  baseId: string;
  name: string;
  permissionLevel: string;
  createdAt: Date;
  updatedAt: Date;
}

const BaseSchema = new Schema<IBase>({
  baseId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  permissionLevel: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Table Schema
export interface ITable extends Document {
  tableId: string;
  baseId: string;
  name: string;
  description?: string;
  primaryFieldId?: string;
  fields: any[];
  views: any[];
  createdAt: Date;
  updatedAt: Date;
}

const TableSchema = new Schema<ITable>({
  tableId: { type: String, required: true, unique: true },
  baseId: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String },
  primaryFieldId: { type: String },
  fields: [{ type: Schema.Types.Mixed }],
  views: [{ type: Schema.Types.Mixed }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Page (Record) Schema
export interface IPage extends Document {
  pageId: string;
  baseId: string;
  tableId: string;
  fields: any;
  createdTime: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PageSchema = new Schema<IPage>({
  pageId: { type: String, required: true, unique: true },
  baseId: { type: String, required: true },
  tableId: { type: String, required: true },
  fields: { type: Schema.Types.Mixed },
  createdTime: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Revision History Schema
export interface IRevisionHistory extends Document {
  pageId: string;
  baseId: string;
  tableId: string;
  revisions: Array<{
    timestamp: Date;
    user: string;
    changeType: "assignee" | "status" | "other";
    fieldName: string;
    oldValue: string;
    newValue: string;
    rawHtml?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const RevisionHistorySchema = new Schema<IRevisionHistory>({
  pageId: { type: String, required: true, unique: true },
  baseId: { type: String, required: true },
  tableId: { type: String, required: true },
  revisions: [
    {
      timestamp: { type: Date, required: true },
      user: { type: String, required: true },
      changeType: {
        type: String,
        enum: ["assignee", "status", "other"],
        required: true,
      },
      fieldName: { type: String, required: true },
      oldValue: { type: String },
      newValue: { type: String },
      rawHtml: { type: String },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Cookie Store Schema
export interface ICookieStore extends Document {
  cookies: string;
  isValid: boolean;
  lastValidated: Date;
  mfaRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CookieStoreSchema = new Schema<ICookieStore>({
  cookies: { type: String, required: true },
  isValid: { type: Boolean, default: true },
  lastValidated: { type: Date, default: Date.now },
  mfaRequired: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export const OAuthToken = mongoose.model<IOAuthToken>(
  "OAuthToken",
  OAuthTokenSchema
);
export const Base = mongoose.model<IBase>("Base", BaseSchema);
export const Table = mongoose.model<ITable>("Table", TableSchema);
export const Page = mongoose.model<IPage>("Page", PageSchema);
export const RevisionHistory = mongoose.model<IRevisionHistory>(
  "RevisionHistory",
  RevisionHistorySchema
);
export const CookieStore = mongoose.model<ICookieStore>(
  "CookieStore",
  CookieStoreSchema
);
