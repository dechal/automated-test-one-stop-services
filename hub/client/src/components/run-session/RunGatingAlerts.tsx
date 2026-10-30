import { Button, Stack } from '@mantine/core';
import { TbAlertTriangle, TbDeviceMobile } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';

export interface RunGatingAlertsProps {
  credentialsMissing: boolean;
  missingReqs: string[];
  appiumMissing: boolean;
  onCredentialsUploaded: () => void;
  onStartAppium: () => void;
  startAppiumPending: boolean;
  startAppiumDisabled: boolean;
}

export function RunGatingAlerts({
  credentialsMissing,
  missingReqs,
  appiumMissing,
  onCredentialsUploaded,
  onStartAppium,
  startAppiumPending,
  startAppiumDisabled,
}: RunGatingAlertsProps) {
  const t = useT();
  return (
    <Stack gap="xs" style={{ flexShrink: 0 }}>
      {credentialsMissing && (
        <InlineAlert
          icon={<TbAlertTriangle size={14} />}
          message={t('run.credentialsMissing')}
          action={
            <Button
              size="compact-xs"
              variant="light"
              color="yellow"
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  const content = await file.text();
                  try {
                    await api.post('/api/doctor/upload-credentials', {
                      content,
                      filename: file.name,
                    });
                    toast.success(t('run.credentialsUploaded'));
                    onCredentialsUploaded();
                  } catch {
                    toast.error(t('run.credentialsUploadFailed'));
                  }
                };
                input.click();
              }}
            >
              {t('run.uploadCredentials')}
            </Button>
          }
        />
      )}
      {missingReqs.length > 0 && (
        <InlineAlert
          icon={<TbAlertTriangle size={14} />}
          message={`${t('run.missingRequirements')}: ${missingReqs.join(', ')}. ${t('run.missingRequirementsHint')}`}
        />
      )}
      {appiumMissing && (
        <InlineAlert
          icon={<TbDeviceMobile size={14} />}
          message={t('run.appiumWarning')}
          action={
            <Button
              size="compact-xs"
              variant="light"
              color="yellow"
              onClick={onStartAppium}
              loading={startAppiumPending}
              disabled={startAppiumDisabled}
            >
              {t('run.startAppium')}
            </Button>
          }
        />
      )}
    </Stack>
  );
}
