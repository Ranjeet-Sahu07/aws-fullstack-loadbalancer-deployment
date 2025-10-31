# Deploy Full Stack App on AWS with Load Balancing

This guide walks you through deploying a simple full stack application (React frontend + Node.js/Express backend) on AWS using EC2 and an Application Load Balancer (ALB). It includes Docker-based deployment steps, networking and security configuration, and optional Route 53 setup.

Repository structure:
- /frontend: React app (static build served via Nginx or S3)
- /backend: Node.js/Express API exposing GET /api/message -> { "message": "Hello from backend" }
- Dockerfiles for both frontend and backend

Prerequisites:
- AWS account with permissions for EC2, VPC, ALB, Security Groups, IAM, and Route 53 (optional)
- Domain name (optional, Route 53 hosted zone or external registrar)
- Git, Docker, and AWS CLI v2 installed locally

----------------------------------------
1) VPC and Security Groups
----------------------------------------
Option A: Use default VPC (simpler for practice)
- Ensure default VPC has at least two public subnets in different AZs.

Option B: Create custom VPC
- VPC CIDR: 10.0.0.0/16
- Two public subnets in different AZs (e.g., 10.0.1.0/24, 10.0.2.0/24)
- Internet Gateway attached to VPC
- Public route table with 0.0.0.0/0 route to IGW, associated with both public subnets

Create Security Groups:
- SG-ALB (for Load Balancer)
  - Inbound: 80/tcp from 0.0.0.0/0 (and ::/0 if IPv6)
  - Optional: 443/tcp if adding TLS
  - Outbound: allow all
- SG-APP (for backend EC2 instances)
  - Inbound: 3000/tcp from SG-ALB (reference by security group), and 22/tcp from your IP for SSH
  - Outbound: allow all
- SG-FRONTEND (if serving frontend from EC2)
  - Inbound: 80/tcp from 0.0.0.0/0, 22/tcp from your IP
  - Outbound: allow all

----------------------------------------
2) Backend EC2 Instances (Dockerized Node.js/Express)
----------------------------------------
Launch 2 EC2 instances (Amazon Linux 2023 or Ubuntu 22.04) in two AZs using SG-APP.
Instance size: t3.micro or t2.micro. Key pair: your-key.pem.

User data to bootstrap (optional) for Amazon Linux 2023:

#!/bin/bash
set -euxo pipefail
amazon-linux-extras enable docker || true
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user

# Pull code (or use ECR image)
mkdir -p /opt/app && cd /opt/app
# If using git clone:
# git clone https://github.com/<your-username>/aws-fullstack-loadbalancer-deployment.git .
# docker build -t backend:latest ./backend
# docker run -d --name backend -p 3000:3000 --restart unless-stopped backend:latest

# Or pull from registry (if you pushed an image)

Manual steps (if not using user data):

# SSH into each backend instance
ssh -i your-key.pem ec2-user@EC2_PUBLIC_IP

# Install Docker
sudo amazon-linux-extras enable docker || true
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
newgrp docker

# Deploy backend container
sudo dnf install -y git
git clone https://github.com/<your-username>/aws-fullstack-loadbalancer-deployment.git
cd aws-fullstack-loadbalancer-deployment/backend
docker build -t backend:latest .
docker run -d --name backend -p 3000:3000 --restart unless-stopped backend:latest

Test locally on the instance:

curl http://127.0.0.1:3000/api/message
# Expect: { "message": "Hello from backend" }

----------------------------------------
3) Application Load Balancer (ALB) for Backend
----------------------------------------
- Create Target Group:
  - Type: Instances (HTTP)
  - Protocol: HTTP, Port: 3000
  - Health check: /health (add a simple health endpoint) or /api/message
  - Register both backend instances
- Create ALB:
  - Scheme: Internet-facing
  - VPC: your VPC
  - Subnets: select at least two public subnets (different AZs)
  - Security group: SG-ALB
  - Listener: HTTP :80 -> forward to the target group

Verify health checks are healthy. Then test:

curl http://<ALB-DNS-NAME>/api/message

You should see JSON and requests distributed across instances (observe container logs on each instance).

----------------------------------------
4) Frontend Deployment
----------------------------------------
Option A: S3 Static Website + CloudFront (recommended)
- Build frontend locally or on CI:

cd frontend
npm ci
npm run build

- Create S3 bucket (must be globally unique):

aws s3 mb s3://your-frontend-bucket
aws s3 sync build/ s3://your-frontend-bucket --delete

- Enable static website hosting on the bucket or use CloudFront for HTTPS
- Set environment/config so frontend fetches from http://<ALB-DNS-NAME>/api/message

Option B: EC2 + Nginx (simple)
- Launch 1 EC2 instance using SG-FRONTEND
- SSH and install Docker and Nginx container or serve build via Nginx host

# Example with Dockerized Nginx serving React build
ssh -i your-key.pem ec2-user@FRONTEND_EC2_IP
sudo amazon-linux-extras enable docker || true
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
newgrp docker

git clone https://github.com/<your-username>/aws-fullstack-loadbalancer-deployment.git
cd aws-fullstack-loadbalancer-deployment/frontend
npm ci
npm run build

# Minimal Nginx container to serve build/
cat > default.conf <<'NGINX'
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  location / {
    try_files $uri /index.html;
  }
}
NGINX

docker run -d --name frontend -p 80:80 -v $(pwd)/build:/usr/share/nginx/html:ro -v $(pwd)/default.conf:/etc/nginx/conf.d/default.conf:ro nginx:alpine

Then access http://FRONTEND_EC2_PUBLIC_IP/ in your browser.

----------------------------------------
5) Environment and CORS
----------------------------------------
- Ensure frontend points to the ALB URL for API calls. Example: REACT_APP_API_BASE=http://<ALB-DNS-NAME>
- If serving frontend from another origin, enable CORS in backend (sample provided in backend/app.js)

----------------------------------------
6) Optional: TLS and Route 53
----------------------------------------
- In ACM (us-east-1 for CloudFront or your ALB region), request a certificate for your domain (e.g., api.example.com, app.example.com)
- Attach HTTPS (443) listener to ALB with that certificate; redirect HTTP->HTTPS
- Route 53: create A/AAAA aliases pointing app.example.com to CloudFront or frontend EC2, and api.example.com to the ALB

----------------------------------------
7) Backend Dockerfile and Healthcheck
----------------------------------------
Example backend Dockerfile (already present in /backend):

FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]

Expose /health in server.js:

app.get('/health', (req, res) => res.status(200).send('ok'));

----------------------------------------
8) Frontend Dockerfile (optional)
----------------------------------------
Multi-stage build serving static files with Nginx:

# build stage
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# serve stage
FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

----------------------------------------
9) Testing
----------------------------------------
- Backend: curl http://<ALB-DNS-NAME>/api/message -> should return JSON
- Frontend: visit http://<FRONTEND_HOST>/ and confirm the API message renders
- Stop one backend instance and refresh; the ALB should continue serving from the healthy instance

----------------------------------------
10) Clean Up
----------------------------------------
- Terminate EC2 instances (frontend and backend)
- Delete ALB and target group
- Delete S3 bucket / CloudFront distribution if used
- Remove Route 53 records if created

----------------------------------------
11) Useful Commands Reference
----------------------------------------
# System updates
sudo dnf update -y

# Docker service
sudo systemctl status docker
sudo systemctl restart docker

# Container management
docker ps -a
docker logs -f backend

# Nginx container reload (if using a compose setup)
docker restart frontend

----------------------------------------
Commit History Suggestions
----------------------------------------
- Added backend server
- Configured frontend React app
- Added Dockerfiles and Nginx config
- Added detailed AWS deployment README

Notes
- Replace <your-username>, <ALB-DNS-NAME>, and IPs with your actual values.
- Use IAM roles for EC2 where possible instead of long-lived keys.
- For production, prefer private subnets for backend with NAT, and HTTPS everywhere.
