import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PluginEntitlementKey, PatchInstanceGeneralSettings } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Trash2 } from "lucide-react";
import { useTranslation } from "@/i18n"; // myrmidon(UI-RU)

export function PluginEntitlementSettings() {
  const { t } = useTranslation(); // myrmidon(UI-RU)
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");

  const { data: settings, isLoading } = useQuery({
    queryKey: ["instance", "generalSettings"],
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const pluginKeys = settings?.pluginEntitlementKeys || [];

  const updateSettingsMutation = useMutation({
    mutationFn: (patch: PatchInstanceGeneralSettings) => instanceSettingsApi.updateGeneral(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["instance", "generalSettings"] });
      toast({
        title: t("pluginEntitlement.keyAdded"),
        variant: "default",
      });
    },
    onError: (error) => {
      toast({
        title: t("settings.failedToUpdate"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const handleAddKey = () => {
    if (!newKey.trim()) {
      toast({
        title: t("pluginEntitlement.invalidKey"),
        variant: "destructive",
      });
      return;
    }

    // Basic validation - key should start with PC-
    if (!newKey.startsWith("PC-")) {
      toast({
        title: t("pluginEntitlement.invalidKey"),
        variant: "destructive",
      });
      return;
    }

    // Extract plugin ID from key (format: PC-plugin_id-...)
    const keyParts = newKey.split("-");
    if (keyParts.length < 2) {
      toast({
        title: t("pluginEntitlement.invalidKey"),
        variant: "destructive",
      });
      return;
    }

    const pluginId = keyParts[1].replace(/_/g, '.');
    
    // Check if key already exists for this plugin
    if (pluginKeys.some(key => key.pluginId === pluginId)) {
      toast({
        title: "Key already exists for this plugin",
        variant: "destructive",
      });
      return;
    }

    const updatedKeys = [
      ...pluginKeys,
      {
        key: newKey,
        pluginId,
        issuedAt: new Date().toISOString(),
        expiresAt: null, // Will be determined by validation
        status: "valid" // Will be updated by server validation
      } as PluginEntitlementKey
    ];

    updateSettingsMutation.mutate({
      pluginEntitlementKeys: updatedKeys
    });

    setNewKey("");
  };

  const handleRemoveKey = (pluginId: string) => {
    const updatedKeys = pluginKeys.filter(key => key.pluginId !== pluginId);
    
    updateSettingsMutation.mutate({
      pluginEntitlementKeys: updatedKeys
    });

    toast({
      title: t("pluginEntitlement.keyRemoved"),
      variant: "default",
    });
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">{t("settings.loadingSettings")}</div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pluginEntitlement.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("pluginEntitlement.subtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder={t("pluginEntitlement.keyPlaceholder")}
            className="flex-1"
          />
          <Button 
            onClick={handleAddKey} 
            disabled={updateSettingsMutation.isPending}
          >
            {t("pluginEntitlement.addKey")}
          </Button>
        </div>

        {pluginKeys.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("pluginEntitlement.pluginName")}</TableHead>
                <TableHead>{t("pluginEntitlement.status")}</TableHead>
                <TableHead>{t("pluginEntitlement.issuedDate")}</TableHead>
                <TableHead>{t("pluginEntitlement.expiresDate")}</TableHead>
                <TableHead className="text-right">{t("pluginEntitlement.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pluginKeys.map((keyInfo) => (
                <TableRow key={keyInfo.pluginId}>
                  <TableCell className="font-medium">{keyInfo.pluginId}</TableCell>
                  <TableCell>
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      keyInfo.status === "valid" 
                        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" 
                        : keyInfo.status === "expired" 
                          ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" 
                          : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                    }`}>
                      {keyInfo.status === "valid" 
                        ? t("pluginEntitlement.statusValid") 
                        : keyInfo.status === "expired" 
                          ? t("pluginEntitlement.statusExpired") 
                          : t("pluginEntitlement.statusInvalid")}
                    </span>
                  </TableCell>
                  <TableCell>{new Date(keyInfo.issuedAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {keyInfo.expiresAt 
                      ? new Date(keyInfo.expiresAt).toLocaleDateString() 
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveKey(keyInfo.pluginId)}
                      disabled={updateSettingsMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            {t("pluginEntitlement.noKeys")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}