
import { useState, useEffect } from "react";
import { AlertTriangle, CheckCircle2, ShieldAlert, RefreshCw } from "lucide-react";
import { api } from "@/api/client";
import { toolsApi } from "@/api/tools";
import type { ToolComplaint, ToolComplaintThresholdWarning } from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ToolComplaintsTabProps {
  companyId: string;
}

export function ToolComplaintsTab({ companyId }: ToolComplaintsTabProps) {
  const [complaints, setComplaints] = useState<ToolComplaint[]>([]);
  const [thresholdWarnings, setThresholdWarnings] = useState<ToolComplaintThresholdWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFeed = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await toolsApi.listComplaints(companyId);
      setComplaints(res.complaints);
      setThresholdWarnings(res.thresholdWarnings);
    } catch (err: any) {
      setError(err?.message || "Failed to load tool complaints");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (companyId) {
      loadFeed();
    }
  }, [companyId]);

  const handleUpdateStatus = async (complaintId: string, status: "open" | "acknowledged" | "resolved", disableTool?: boolean) => {
    try {
      await toolsApi.updateComplaint(companyId, complaintId, { status, disableTool });
      await loadFeed();
    } catch (err: any) {
      alert(err?.message || "Failed to update complaint");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Agent Tool Complaints & Triage</h2>
          <p className="text-sm text-muted-foreground">
            Monitor agent-filed tool complaints, threshold warnings, and disable misbehaving tools safely.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadFeed} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/15 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {thresholdWarnings.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {thresholdWarnings.map((w) => (
            <Card key={w.tool} className={w.warning ? "border-destructive/50 bg-destructive/5" : ""}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{w.tool}</CardTitle>
                {w.warning ? <ShieldAlert className="h-4 w-4 text-destructive" /> : <AlertTriangle className="h-4 w-4 text-yellow-500" />}
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{w.openCount} / {w.threshold}</div>
                <p className="text-xs text-muted-foreground">
                  {w.warning ? "Threshold reached: auto-disable recommended or review complaints" : "Active complaints below threshold"}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="rounded-md border bg-card">
        <div className="p-4 font-semibold border-b">Complaints Feed</div>
        {complaints.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No complaints filed yet.
          </div>
        ) : (
          <div className="divide-y">
            {complaints.map((c) => (
              <div key={c.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium text-sm">{c.tool}</span>
                    <span className={`px-2 py-0.5 text-xs rounded-full font-semibold uppercase ${
                      c.severity === "critical" ? "bg-red-100 text-red-800" :
                      c.severity === "high" ? "bg-orange-100 text-orange-800" :
                      c.severity === "medium" ? "bg-yellow-100 text-yellow-800" : "bg-blue-100 text-blue-800"
                    }`}>
                      {c.severity}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                      c.status === "resolved" ? "bg-green-100 text-green-800" :
                      c.status === "acknowledged" ? "bg-purple-100 text-purple-800" : "bg-gray-100 text-gray-800"
                    }`}>
                      {c.status}
                    </span>
                  </div>
                  <p className="text-sm text-foreground/90">{c.issue}</p>
                  <div className="text-xs text-muted-foreground">
                    Agent: <span className="font-mono">{c.agentId}</span> • Filed: {new Date(c.createdAt).toLocaleString()}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {c.status !== "acknowledged" && c.status !== "resolved" && (
                    <Button variant="outline" size="sm" onClick={() => handleUpdateStatus(c.id, "acknowledged")}>
                      Acknowledge
                    </Button>
                  )}
                  {c.status !== "resolved" && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => handleUpdateStatus(c.id, "resolved")}>
                        <CheckCircle2 className="mr-1 h-4 w-4 text-green-600" />
                        Resolve
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => handleUpdateStatus(c.id, "resolved", true)}>
                        Resolve & Disable Tool
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
