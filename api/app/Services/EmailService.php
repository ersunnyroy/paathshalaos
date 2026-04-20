<?php

namespace App\Services;

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\SMTP;
use PHPMailer\Exception as PHPMailerException;
use App\Repositories\Contracts\SmtpSettingsRepositoryInterface;
use App\Models\Tenant;
use App\Models\SmtpSetting;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class EmailService
{
    private ?PHPMailer $mailer = null;

    public function __construct(
        private SmtpSettingsRepositoryInterface $smtpSettingsRepository
    ) {}

    public function sendFromTemplate(string $templateSlug, array $params, ?Tenant $tenant = null): bool
    {
        $template = $this->smtpSettingsRepository->findActiveTemplate($templateSlug);

        if (!$template) {
            Log::warning('Email template not found or inactive', [
                'slug' => $templateSlug,
            ]);
            return false;
        }

        $processedSubject = $this->processVariables($template->subject, $params);
        $processedBody = $this->processVariables($template->body, $params);
        $wrappedBody = $this->buildEmailWrapper($processedBody, $tenant);

        return $this->send([
            'to' => $params['to'] ?? null,
            'to_name' => $params['to_name'] ?? null,
            'subject' => $processedSubject,
            'body' => $wrappedBody,
            'tenant' => $tenant,
        ]);
    }

    public function send(array $params): bool
    {
        $to = $params['to'] ?? null;
        $toName = $params['to_name'] ?? null;
        $subject = $params['subject'] ?? '';
        $body = $params['body'] ?? '';
        $altBody = $params['alt_body'] ?? null;
        $tenant = $params['tenant'] ?? null;
        $cc = $params['cc'] ?? [];
        $bcc = $params['bcc'] ?? [];
        $attachments = $params['attachments'] ?? [];

        if (!$to) {
            Log::error('Email send failed: no recipient');
            return false;
        }

        try {
            $this->configureMailer($tenant);

            $this->mailer->isHTML(true);
            $this->mailer->addAddress($to, $toName);
            $this->mailer->Subject = $subject;
            $this->mailer->Body = $body;

            if ($altBody) {
                $this->mailer->AltBody = $altBody;
            }

            foreach ($cc as $ccEmail => $ccName) {
                $this->mailer->addCC(is_numeric($ccEmail) ? $ccName : $ccEmail, is_numeric($ccEmail) ? '' : $ccName);
            }

            foreach ($bcc as $bccEmail => $bccName) {
                $this->mailer->addBCC(is_numeric($bccEmail) ? $bccName : $bccEmail, is_numeric($bccEmail) ? '' : $bccName);
            }

            foreach ($attachments as $attachment) {
                if (is_array($attachment)) {
                    $this->mailer->addAttachment($attachment['path'], $attachment['name'] ?? '');
                } else {
                    $this->mailer->addAttachment($attachment);
                }
            }

            $result = $this->mailer->send();

            Log::info('Email sent successfully', [
                'to' => $to,
                'subject' => $subject,
                'tenant_id' => $tenant?->id,
            ]);

            return $result;
        } catch (PHPMailerException $e) {
            Log::error('Failed to send email', [
                'error' => $e->getMessage(),
                'tenant_id' => $tenant?->id,
            ]);
            return false;
        } finally {
            $this->reset();
        }
    }

    private function configureMailer(?Tenant $tenant): void
    {
        $this->mailer = new PHPMailer(true);
        $this->mailer->isSMTP();

        $smtpConfig = $this->getSmtpConfig($tenant);

        $this->mailer->Host = $smtpConfig->host;
        $this->mailer->Port = $smtpConfig->port ?: 587;
        $this->mailer->SMTPSecure = $smtpConfig->encryption ?: PHPMailer::ENCRYPTION_STARTTLS;

        if ($smtpConfig->username && $smtpConfig->password) {
            $this->mailer->SMTPAuth = true;
            $this->mailer->Username = $smtpConfig->username;
            $this->mailer->Password = $smtpConfig->password;
        }

        $this->mailer->setFrom($smtpConfig->from_email, $tenant?->name ?? $smtpConfig->from_name);
    }

    private function getSmtpConfig(?Tenant $tenant): SmtpSetting
    {
        if ($tenant) {
            $tenantConfig = $this->smtpSettingsRepository->findByTenant($tenant->id);
            if ($tenantConfig && $tenantConfig->host) {
                return $tenantConfig;
            }
        }

        $platformConfig = $this->smtpSettingsRepository->findPlatform();

        if (!$platformConfig) {
            $platformConfig = $this->getDefaultPlatformConfig();
        }

        return $platformConfig;
    }

    private function getDefaultPlatformConfig(): SmtpSetting
    {
        $config = config('mail.mailers.smtp');

        $smtpSetting = new SmtpSetting();
        $smtpSetting->host = $config['host'] ?? 'smtp.gmail.com';
        $smtpSetting->port = $config['port'] ?? 587;
        $smtpSetting->username = $config['username'] ?? null;
        $smtpSetting->password = $config['password'] ?? null;
        $smtpSetting->encryption = $config['encryption'] ?? 'tls';
        $smtpSetting->from_email = $config['from']['address'] ?? 'noreply@paathshala.com';
        $smtpSetting->from_name = $config['from']['name'] ?? 'PaathshalaOS';

        return $smtpSetting;
    }

    private function processVariables(string $content, array $params): string
    {
        foreach ($params as $key => $value) {
            if (is_string($value)) {
                $content = str_replace('{{' . $key . '}}', $value, $content);
            }
        }
        return $content;
    }

    private function buildEmailWrapper(string $body, ?Tenant $tenant): string
    {
        $logoUrl = $tenant?->logo 
            ? asset('storage/' . $tenant->logo) 
            : asset('logo.png');
        
        $tenantName = $tenant?->name ?? 'PaathshalaOS';
        $contactNumber = $tenant?->phone;
        $contactHtml = $contactNumber ? '<p style="margin: 0;">Contact: ' . $contactNumber . '</p>' : '';

        return <<<HTML
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #e5e7eb;">
                <img src="{$logoUrl}" alt="{$tenantName}" style="max-height: 60px;" />
            </div>
            <div style="margin-bottom: 30px;">
                {$body}
            </div>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px;">
                <p style="margin: 0;">Regards,</p>
                <p style="margin: 5px 0; font-weight: bold;">{$tenantName}</p>
                {$contactHtml}
                <p style="margin-top: 10px;">© 2026 PaathshalaOS. All rights reserved.</p>
            </div>
        </div>
        HTML;
    }

    private function reset(): void
    {
        if ($this->mailer) {
            $this->mailer->clearAddresses();
            $this->mailer->clearAttachments();
            $this->mailer->clearCCs();
            $this->mailer->clearBCCs();
            $this->mailer->clearReplyTos();
        }
    }

    public static function quickSend(string $templateSlug, array $params, ?Tenant $tenant = null): bool
    {
        $service = app(self::class);
        return $service->sendFromTemplate($templateSlug, $params, $tenant);
    }
}