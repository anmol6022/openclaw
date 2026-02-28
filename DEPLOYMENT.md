# Deploying OpenClaw to Google Cloud Run

This guide explains how to deploy your customized OpenClaw instance to Google Cloud Run.

## Prerequisites

1.  Google Cloud SDK (`gcloud`) installed and configured.
2.  A Google Cloud project with billing enabled.
3.  Docker installed locally (optional, but recommended for testing).

## 1. Setup

Enable the necessary APIs in your Google Cloud Project:

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com
```

Create an Artifact Registry repository for your Docker images:

```bash
gcloud artifacts repositories create openclaw-repo \
    --repository-format=docker \
    --location=us-central1 \
    --description="Docker repository for OpenClaw"
```

## 2. Build and Push the Docker Image

You can build and push the image using Google Cloud Build:

```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/openclaw-repo/openclaw:latest
```

_(Replace `YOUR_PROJECT_ID` with your actual Google Cloud Project ID)._

## 3. Deploy to Cloud Run

Deploy the image to Cloud Run. Keep in mind that OpenClaw needs continuous CPU to handle incoming webhook requests and agent processing quickly.

```bash
gcloud run deploy openclaw-service \
    --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/openclaw-repo/openclaw:latest \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --memory 2Gi \
    --cpu 1 \
    --set-env-vars="NODE_ENV=production" \
    --set-env-vars="PORT=8080" \
    --set-secrets="GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest" \
    --set-secrets="SLACK_CLIENT_ID=slack-client-id:latest,SLACK_CLIENT_SECRET=slack-client-secret:latest" \
    --set-secrets="OPENAI_API_KEY=openai-api-key:latest" \
    --execution-environment=gen2
```

### Important Notes on the Deployment Flags:

- `--memory 2Gi`: OpenClaw with agents and SQLite vector extensions requires at least 1-2GB of memory.
- `--allow-unauthenticated`: We are allowing external access since Telegram webhooks and Slack events must be able to reach it.
- `--set-secrets`: You must have created these secrets previously in Google Cloud Secret Manager.

## 4. Setting up Webhooks

Once deployed, Cloud Run will provide you with a URL (e.g., `https://openclaw-service-xxxxx-uc.a.run.app`).

1.  **Telegram**: Set your Telegram Bot webhook to point to `https://<YOUR_CLOUD_RUN_URL>/telegram/webhook`.
2.  **Slack**: Go to your Slack App configuration and set the Event Subscriptions Request URL to `https://<YOUR_CLOUD_RUN_URL>/slack/events`.
3.  **Google OAuth**: In your Google Cloud Console Credentials page, add `https://<YOUR_CLOUD_RUN_URL>/auth/google` as an Authorized redirect URI.

## 5. Storage (Optional for Stateful Deployments)

By default, this setup uses the ephemeral container filesystem for `/data` (where `sqlite-vec` index and sessions are stored). If a container restarts, its historical state will be lost.
For a true production deployment, you MUST mount a Cloud Storage Volume (Google Cloud Storage FUSE) or a Memorystore/PostgreSQL instance to preserve `/data` files.

Example of attaching a Cloud Storage bucket as a volume:

```bash
gcloud run services update openclaw-service \
    --add-volume=name=data-volume,type=cloud-storage,bucket=YOUR_GCS_BUCKET_NAME \
    --add-volume-mount=volume=data-volume,mount-path=/data
```
