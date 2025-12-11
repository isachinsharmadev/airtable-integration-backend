import mongoose, { Schema, Document } from "mongoose";

export interface IOAuthToken extends Document {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  createdAt: Date;
  updatedAt: Date;
}

const OAuthTokenSchema = new Schema<IOAuthToken>(
  {
    accessToken: {
      type: String,
      required: true,
      description: "OAuth 2.0 access token for Airtable API",
    },
    refreshToken: {
      type: String,
      required: true,
      description: "OAuth 2.0 refresh token for token renewal",
    },
    expiresAt: {
      type: Date,
      required: true,
      description: "Token expiration timestamp",
    },
    scope: {
      type: String,
      description: "Granted OAuth scopes (space-separated)",
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

OAuthTokenSchema.index({ updatedAt: -1 });

export interface IBase extends Document {
  baseId: string;
  name: string;
  permissionLevel: string;
  createdAt: Date;
  updatedAt: Date;
}

const BaseSchema = new Schema<IBase>(
  {
    baseId: {
      type: String,
      required: true,
      unique: true,
      description: "Unique Airtable base identifier (appXXXXXXXXXXXXXX)",
    },
    name: {
      type: String,
      required: true,
      description: "Human-readable base name",
    },
    permissionLevel: {
      type: String,
      description: "User's permission level (owner, editor, viewer)",
    },
  },
  {
    timestamps: true,
  }
);

BaseSchema.index({ baseId: 1 }, { unique: true });
BaseSchema.index({ updatedAt: -1 });

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

const TableSchema = new Schema<ITable>(
  {
    tableId: {
      type: String,
      required: true,
      unique: true,
      description: "Unique Airtable table identifier (tblXXXXXXXXXXXXXX)",
    },
    baseId: {
      type: String,
      required: true,
      description: "Parent base identifier",
    },
    name: {
      type: String,
      required: true,
      description: "Human-readable table name",
    },
    description: {
      type: String,
      description: "Optional table description",
    },
    primaryFieldId: {
      type: String,
      description: "ID of the primary field",
    },
    fields: [{ type: Schema.Types.Mixed }],
    views: [{ type: Schema.Types.Mixed }],
  },
  {
    timestamps: true,
  }
);

TableSchema.index({ tableId: 1 }, { unique: true });
TableSchema.index({ baseId: 1 });
TableSchema.index({ updatedAt: -1 });

export interface IPage extends Document {
  pageId: string;
  baseId: string;
  tableId: string;
  fields: any;
  createdTime: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PageSchema = new Schema<IPage>(
  {
    pageId: {
      type: String,
      required: true,
      unique: true,
      description: "Unique Airtable record identifier (recXXXXXXXXXXXXXX)",
    },
    baseId: {
      type: String,
      required: true,
      description: "Parent base identifier",
    },
    tableId: {
      type: String,
      required: true,
      description: "Parent table identifier",
    },
    fields: {
      type: Schema.Types.Mixed,
      description: "Record field values (key-value pairs)",
    },
    createdTime: {
      type: Date,
      description: "When record was created in Airtable",
    },
  },
  {
    timestamps: true,
  }
);

PageSchema.index({ pageId: 1 }, { unique: true });
PageSchema.index({ baseId: 1, tableId: 1 });
PageSchema.index({ updatedAt: -1 });

export interface IRevisionHistoryItem {
  uuid: string;
  issueId: string;
  columnType: "assignee" | "status";
  oldValue: string | null;
  newValue: string | null;
  createdDate: Date;
  authoredBy: string;
}

export interface IRevisionHistory extends Document {
  pageId: string;
  baseId: string;
  tableId: string;
  revisions: IRevisionHistoryItem[];
  updatedAt: Date;
  createdAt: Date;
}

const RevisionHistoryItemSchema = new Schema<IRevisionHistoryItem>(
  {
    uuid: {
      type: String,
      required: true,
      description: "Unique identifier for this activity/change",
    },
    issueId: {
      type: String,
      required: true,
      description: "Record ID (recXXXXXXXXXXXXXX)",
    },
    columnType: {
      type: String,
      required: true,
      enum: ["assignee", "status"],
      description: "Type of change tracked",
    },
    oldValue: {
      type: String,
      default: null,
      description: "Previous value before change",
    },
    newValue: {
      type: String,
      default: null,
      description: "New value after change",
    },
    createdDate: {
      type: Date,
      required: true,
      description: "When the change occurred",
    },
    authoredBy: {
      type: String,
      required: true,
      description: "User who made the change (name or email)",
    },
  },
  {
    _id: false, // Don't create _id for embedded documents
  }
);

const RevisionHistorySchema = new Schema<IRevisionHistory>(
  {
    pageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      description: "Record ID this history belongs to",
    },
    baseId: {
      type: String,
      required: true,
      index: true,
      description: "Parent base ID",
    },
    tableId: {
      type: String,
      required: true,
      index: true,
      description: "Parent table ID",
    },
    revisions: {
      type: [RevisionHistoryItemSchema],
      default: [],
      description: "Array of parsed changes (assignee & status only)",
    },
  },
  {
    timestamps: true,
  }
);

RevisionHistorySchema.index({ baseId: 1, tableId: 1 });
RevisionHistorySchema.index({ pageId: 1 }, { unique: true });
RevisionHistorySchema.index({ updatedAt: -1 });

export interface ICookieStore extends Document {
  cookies: string;
  isValid: boolean;
  lastValidated: Date;
  mfaRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CookieStoreSchema = new Schema<ICookieStore>(
  {
    cookies: {
      type: String,
      required: true,
      description: "Semicolon-separated cookie string from Puppeteer",
    },
    isValid: {
      type: Boolean,
      default: true,
      description: "Whether cookies are still valid",
    },
    lastValidated: {
      type: Date,
      default: Date.now,
      description: "Last time cookies were validated",
    },
    mfaRequired: {
      type: Boolean,
      default: false,
      description: "Whether MFA code was needed during authentication",
    },
  },
  {
    timestamps: true,
  }
);

CookieStoreSchema.index({ updatedAt: -1 });
CookieStoreSchema.index({ isValid: 1 });

export interface IUser extends Document {
  userId: string;
  email: string;
  name?: string;
  scopes?: string[];
  type: "current_user" | "collaborator" | "current_user_and_collaborator";
  source: "whoami" | "base_metadata";
  sources?: string[];
  baseId?: string;
  permissionLevel?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      description: "Unique Airtable user identifier (usrXXXXXXXXXXXXXX)",
    },
    email: {
      type: String,
      required: true,
      description: "User email address",
    },
    name: {
      type: String,
      description: "User display name",
    },
    scopes: {
      type: [String],
      default: [],
      description: "OAuth scopes granted to this user",
    },
    type: {
      type: String,
      required: true,
      enum: ["current_user", "collaborator", "current_user_and_collaborator"],
      description: "User type based on how they were discovered",
    },
    source: {
      type: String,
      required: true,
      enum: ["whoami", "base_metadata"],
      description: "Primary source where user was found",
    },
    sources: {
      type: [String],
      default: [],
      description: "All sources where user was found (for merged records)",
    },
    baseId: {
      type: String,
      index: true,
      description: "Base ID if user is a collaborator on specific base",
    },
    permissionLevel: {
      type: String,
      description: "Permission level (owner, create, edit, comment, read)",
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
UserSchema.index({ userId: 1 }, { unique: true });
UserSchema.index({ baseId: 1 });
UserSchema.index({ email: 1 });
UserSchema.index({ baseId: 1, userId: 1 }); // Compound index for base-specific user queries
UserSchema.index({ updatedAt: -1 });

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

export const User = mongoose.model<IUser>("User", UserSchema);

export async function getModelStats() {
  const [bases, tables, pages, revisions, tokens, cookies, users] =
    await Promise.all([
      Base.countDocuments(),
      Table.countDocuments(),
      Page.countDocuments(),
      RevisionHistory.countDocuments(),
      OAuthToken.countDocuments(),
      CookieStore.countDocuments(),
      User.countDocuments(),
    ]);

  return {
    bases,
    tables,
    pages,
    revisions,
    tokens,
    cookies,
    users,
  };
}
