export interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  language?: string;
  family_friendly?: boolean;
}

export interface BraveDiscussionResult {
  title: string;
  url: string;
  description: string;
  data?: { forum?: { name?: string }; title?: string };
}

export interface BraveFAQ {
  question: string;
  answer: string;
  title: string;
  url: string;
}

export interface BraveNewsResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  breaking?: boolean;
}

export interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
    total_results?: number;
  };
  discussion?: {
    results?: BraveDiscussionResult[];
  };
  faq?: {
    results?: BraveFAQ[];
  };
  news?: {
    results?: BraveNewsResult[];
  };
}
