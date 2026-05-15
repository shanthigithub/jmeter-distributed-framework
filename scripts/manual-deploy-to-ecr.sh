#!/bin/bash
# Manual ECR Deployment Script
# Run this in AWS CloudShell or any machine with Docker and AWS CLI

set -e

echo "=========================================="
echo "Manual ECR Deployment"
echo "=========================================="
echo ""

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "AWS Account ID: $ACCOUNT_ID"
echo "AWS Region: us-east-1"
echo ""

# Clone or update repo
if [ -d "jmeter-framework" ]; then
    echo "Updating existing repo..."
    cd jmeter-framework
    git fetch origin
    git checkout main
    git pull origin main
else
    echo "Cloning repo..."
    git clone https://github.com/shanthigithub/jmeter-framework.git
    cd jmeter-framework
fi

echo ""
echo "Verifying fix is present..."
if grep -q "set +e  # Disable exit-on-error" docker/entrypoint.sh; then
    echo "✅ Fix confirmed in docker/entrypoint.sh"
else
    echo "❌ Fix not found! Check git commit."
    exit 1
fi

echo ""
echo "=========================================="
echo "Building Docker Image..."
echo "=========================================="
docker build -t jmeter-framework:latest -f docker/Dockerfile .

echo ""
echo "=========================================="
echo "Logging into ECR..."
echo "=========================================="
aws ecr get-login-password --region us-east-1 | \
    docker login --username AWS --password-stdin \
    ${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com

echo ""
echo "=========================================="
echo "Tagging Image..."
echo "=========================================="
docker tag jmeter-framework:latest \
    ${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/jmeter-framework:latest

echo ""
echo "=========================================="
echo "Pushing to ECR..."
echo "=========================================="
docker push ${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/jmeter-framework:latest

echo ""
echo "=========================================="
echo "✅ DEPLOYMENT COMPLETE!"
echo "=========================================="
echo "Image: ${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/jmeter-framework:latest"
echo ""
echo "Next test run will use this fixed image!"
echo ""