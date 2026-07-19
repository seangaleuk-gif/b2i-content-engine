"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { Input } from "./Input";
import { Button } from "./Button";

interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ProjectFormData) => Promise<void>;
}

export interface ProjectFormData {
  name: string;
  keyword: string;
  audience: string;
  country: string;
  wordCount?: number;
}

const AUDIENCES = [
  "Small Business Owners",
  "Marketing Managers",
  "B2B Decision Makers",
  "Startup Founders",
  "Content Creators",
  "E-commerce Managers",
  "Hong Kong SMEs",
  "General Audience",
];

const COUNTRIES = [
  "HK", "US", "UK", "AU", "CA", "SG", "MY", "PH", "IN", "JP",
];

export function NewProjectModal({ open, onClose, onSubmit }: NewProjectModalProps) {
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [audience, setAudience] = useState(AUDIENCES[0]);
  const [country, setCountry] = useState("HK");
  const [wordCount, setWordCount] = useState(2500);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Topic name is required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onSubmit({ name: name.trim(), keyword: keyword.trim(), audience, country, wordCount });
      setName("");
      setKeyword("");
      setAudience(AUDIENCES[0]);
      setCountry("HK");
      setWordCount(2500);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Project">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Topic / Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. AI Lead Generation for B2B SaaS"
          required
        />
        <Input
          label="Primary Keyword"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="e.g. AI lead generation tools"
        />
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-text-secondary">
            Target Audience
          </label>
          <select
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary focus:outline-none focus:border-accent-primary/50 transition-all"
          >
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-text-secondary">
            Target Country
          </label>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary focus:outline-none focus:border-accent-primary/50 transition-all"
          >
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-text-secondary">
            Target Word Count
          </label>
          <input
            type="number"
            min={500}
            max={5000}
            step={100}
            value={wordCount}
            onChange={(e) => setWordCount(Number(e.target.value))}
            className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary focus:outline-none focus:border-accent-primary/50 transition-all"
          />
        </div>

        {error && (
          <p className="text-[13px] text-accent-danger">{error}</p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" loading={loading} className="flex-1">
            {loading ? "Creating..." : "Create Project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
